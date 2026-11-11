// warp-farm：本地运行，不用 Docker，不用 TUN。
//
// 一个小进程注册 N 个 Cloudflare WARP 设备，每个注册起一个 userspace
// WireGuard（UDP 包，不是网络接口），每个 exit 开一个 SOCKS5 监听。网关把
// 它当成普通 SOCKS5 代理使用，所以现有代理池无需改动。
//
// 改编自 github.com/jasonxu114514/opencode2api（GPL-3.0），后者又改编自
// github.com/sudogeeker/ai-route（MIT）。见 LICENSE 与 NOTICE.md。
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	shutdownGrace = 60 * time.Second
	retryDelay    = 5 * time.Second
	rotateDelay   = 60 * time.Second
)

type lane struct {
	index    int
	port     int
	mu       sync.Mutex
	exit     *exit
	err      string
	rotating bool
	dials    atomic.Int64
	failures atomic.Int64
}

func (l *lane) current() *exit {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.exit
}

func (l *lane) setExit(e *exit) *exit {
	l.mu.Lock()
	defer l.mu.Unlock()
	old := l.exit
	l.exit = e
	l.err = ""
	return old
}

func (l *lane) setErr(err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err == nil {
		l.err = ""
		return
	}
	l.err = err.Error()
}

func (l *lane) beginRotate() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.rotating {
		return false
	}
	l.rotating = true
	return true
}

func (l *lane) endRotate() {
	l.mu.Lock()
	l.rotating = false
	l.mu.Unlock()
}

type laneStatus struct {
	Index    int    `json:"index"`
	Port     int    `json:"port"`
	URL      string `json:"url"`
	Egress   string `json:"egress,omitempty"`
	Ready    bool   `json:"ready"`
	Error    string `json:"error,omitempty"`
	Rotating bool   `json:"rotating"`
	Dials    int64  `json:"dials"`
	Failures int64  `json:"failures"`
}

type farmStatus struct {
	OK          bool         `json:"ok"`
	Stack       string       `json:"stack"`
	Host        string       `json:"host"`
	BasePort    int          `json:"basePort"`
	ControlPort int          `json:"controlPort"`
	Lanes       []laneStatus `json:"lanes"`
}

type farm struct {
	ctx         context.Context
	cancel      context.CancelFunc
	host        string
	basePort    int
	controlPort int
	stack       Stack
	source      netip.Prefix
	registry    *registrar
	buildMu     sync.Mutex
	mu          sync.Mutex
	reserved    map[string]bool
	lanes       []*lane
	listeners   []net.Listener
}

func newFarm(ctx context.Context, host string, basePort, controlPort, size int, stack Stack, source netip.Prefix) *farm {
	farmCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	f := &farm{
		ctx:         farmCtx,
		cancel:      cancel,
		host:        host,
		basePort:    basePort,
		controlPort: controlPort,
		stack:       stack,
		source:      source,
		registry:    newRegistrar(),
		reserved:    make(map[string]bool),
	}
	for i := range size {
		f.lanes = append(f.lanes, &lane{index: i + 1, port: basePort + i})
	}
	return f
}

func (f *farm) start() error {
	for _, l := range f.lanes {
		address := net.JoinHostPort(f.host, strconv.Itoa(l.port))
		ln, err := net.Listen("tcp", address)
		if err != nil {
			return fmt.Errorf("bind SOCKS5 lane %d at %s: %w", l.index, address, err)
		}
		f.listeners = append(f.listeners, ln)
		go serveSOCKS5(ln, l)
	}
	for _, l := range f.lanes {
		go f.fillLane(l)
	}
	return nil
}

// fillLane 为 lane 建立第一个 exit；注册被限流时按窗口重试，而不是让 lane
// 永久失败。
func (f *farm) fillLane(l *lane) {
	for {
		e, err := f.acquireExit()
		if err == nil {
			l.setExit(e)
			log.Printf("warp-farm lane %d ready at %s via port %d", l.index, e.egress, l.port)
			return
		}
		l.setErr(err)
		if f.ctx.Err() != nil {
			return
		}
		log.Printf("warp-farm lane %d: %v", l.index, err)
		pause := retryDelay
		if wait := registrationPause(err); wait > pause {
			pause = wait
		}
		select {
		case <-f.ctx.Done():
			return
		case <-time.After(pause):
		}
	}
}

// acquireExit 注册一个 WARP 设备，并返回一个 egress /64（IPv4 为 /32）尚未
// 被其他 lane 占用的 exit。
func (f *farm) acquireExit() (*exit, error) {
	f.buildMu.Lock()
	defer f.buildMu.Unlock()
	var lastErr error
	for attempt := range 6 {
		reg, err := f.registry.register(f.ctx)
		if err != nil {
			return nil, err
		}
		var source netip.Addr
		if f.source.IsValid() {
			source, err = randomSource(f.source)
			if err != nil {
				return nil, err
			}
		}
		candidate, err := newExitWithStack(f.ctx, reg, f.stack, source)
		if err != nil {
			return nil, err
		}
		key := candidate.egressKey()
		f.mu.Lock()
		duplicate := key == "" || f.reserved[key]
		if !duplicate {
			f.reserved[key] = true
		}
		f.mu.Unlock()
		if !duplicate {
			return candidate, nil
		}
		candidate.close()
		lastErr = fmt.Errorf("WARP egress %s is already active", key)
		log.Printf("warp-farm discarding duplicate egress (attempt %d/6): %s", attempt+1, key)
	}
	if lastErr == nil {
		lastErr = errors.New("cannot obtain a distinct WARP egress")
	}
	return nil, lastErr
}

func (f *farm) releaseExit(e *exit) {
	if e == nil {
		return
	}
	key := e.egressKey()
	if key == "" {
		return
	}
	f.mu.Lock()
	delete(f.reserved, key)
	f.mu.Unlock()
}

// rotate 用一个全新注册的 exit 替换某条 lane 的 exit，egress 随之改变。
// 旧隧道短暂保留，让正在进行的请求跑完。
func (f *farm) rotate(l *lane) error {
	if !l.beginRotate() {
		return errors.New("lane is already rotating")
	}
	defer l.endRotate()
	e, err := f.acquireExit()
	if err != nil {
		l.setErr(err)
		return err
	}
	old := l.setExit(e)
	if old != nil {
		go func() {
			time.Sleep(rotateDelay)
			f.releaseExit(old)
			old.close()
		}()
	}
	log.Printf("warp-farm lane %d rotated to %s", l.index, e.egress)
	return nil
}

func (f *farm) laneByPort(port int) *lane {
	for _, l := range f.lanes {
		if l.port == port {
			return l
		}
	}
	return nil
}

func (f *farm) status() farmStatus {
	status := farmStatus{
		OK:          true,
		Stack:       string(f.stack),
		Host:        f.host,
		BasePort:    f.basePort,
		ControlPort: f.controlPort,
	}
	for _, l := range f.lanes {
		l.mu.Lock()
		egress := ""
		if l.exit != nil {
			egress = l.exit.egress.String()
		}
		entry := laneStatus{
			Index:    l.index,
			Port:     l.port,
			URL:      "socks5://" + net.JoinHostPort(f.host, strconv.Itoa(l.port)),
			Egress:   egress,
			Ready:    l.exit != nil,
			Error:    l.err,
			Rotating: l.rotating,
			Dials:    l.dials.Load(),
			Failures: l.failures.Load(),
		}
		l.mu.Unlock()
		status.Lanes = append(status.Lanes, entry)
	}
	return status
}

func (f *farm) shutdown() {
	f.cancel()
	for _, ln := range f.listeners {
		ln.Close()
	}
	for _, l := range f.lanes {
		if e := l.current(); e != nil {
			e.close()
		}
	}
}

func serveControl(f *farm) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, f.status())
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, f.status())
	})
	mux.HandleFunc("/rotate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		port, err := strconv.Atoi(r.URL.Query().Get("port"))
		if err != nil || port == 0 {
			for _, l := range f.lanes {
				if err := f.rotate(l); err != nil {
					log.Printf("warp-farm rotate lane %d: %v", l.index, err)
				}
			}
			writeJSON(w, http.StatusOK, f.status())
			return
		}
		l := f.laneByPort(port)
		if l == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown lane port"})
			return
		}
		if err := f.rotate(l); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, f.status())
	})
	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		go func() {
			time.Sleep(50 * time.Millisecond)
			f.shutdown()
		}()
	})
	server := &http.Server{
		Addr:              net.JoinHostPort(f.host, strconv.Itoa(f.controlPort)),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("warp-farm control server: %v", err)
		}
	}()
	return server
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// randomSource 从前缀里抽一个主机地址。
func randomSource(prefix netip.Prefix) (netip.Addr, error) {
	address := prefix.Masked().Addr().As16()
	var noise [16]byte
	if _, err := rand.Read(noise[:]); err != nil {
		return netip.Addr{}, fmt.Errorf("draw WARP outer source: %w", err)
	}
	keep := prefix.Bits()
	for index := range address {
		switch bits := keep - index*8; {
		case bits >= 8:
		case bits <= 0:
			address[index] = noise[index]
		default:
			mask := byte(0xFF) << (8 - bits)
			address[index] = address[index]&mask | noise[index]&^mask
		}
	}
	return netip.AddrFrom16(address), nil
}

func intEnv(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func main() {
	host := flag.String("host", "127.0.0.1", "listen address for SOCKS5 lanes and control")
	size := flag.Int("size", intEnv("WARP_FARM_SIZE", 8), "number of WARP exits (1-32)")
	basePort := flag.Int("base-port", intEnv("WARP_FARM_BASE_PORT", 40001), "first SOCKS5 port")
	controlPort := flag.Int("control-port", intEnv("WARP_FARM_CONTROL_PORT", 0), "control HTTP port (0 = base-port-1)")
	stackFlag := flag.String("stack", os.Getenv("WARP_FARM_STACK"), "WARP stack: ipv6, ipv4 or dual")
	sourceFlag := flag.String("source-ipv6", os.Getenv("WARP_FARM_SOURCE_IPV6"), "optional outer IPv6 prefix (/64) each exit binds from")
	flag.Parse()

	if *size < 1 || *size > 32 {
		log.Fatalf("warp-farm: size must be 1-32, got %d", *size)
	}
	if *controlPort == 0 {
		*controlPort = *basePort - 1
	}
	if *controlPort == *basePort {
		log.Fatalf("warp-farm: control port must differ from base port")
	}
	stack, err := ParseStack(*stackFlag)
	if err != nil {
		log.Fatal(err)
	}
	var source netip.Prefix
	if *sourceFlag != "" {
		source, err = netip.ParsePrefix(*sourceFlag)
		if err != nil || !source.Addr().Is6() || source.Bits() > 64 {
			log.Fatalf("warp-farm: -source-ipv6 must be an IPv6 prefix of /64 or shorter, got %q", *sourceFlag)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	f := newFarm(ctx, *host, *basePort, *controlPort, *size, stack, source)
	if err := f.start(); err != nil {
		log.Fatalf("warp-farm: %v", err)
	}
	control := serveControl(f)
	log.Printf("warp-farm ready: control=http://%s/status lanes=%d base=%d stack=%s",
		net.JoinHostPort(*host, strconv.Itoa(*controlPort)), *size, *basePort, stack)

	<-ctx.Done()
	log.Printf("warp-farm shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	_ = control.Shutdown(shutdownCtx)
	f.shutdown()
	time.Sleep(100 * time.Millisecond)
}
