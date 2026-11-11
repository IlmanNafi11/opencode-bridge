package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

const (
	socksVersion       = 0x05
	socksNoAuth        = 0x00
	socksCommandConnect = 0x01
	socksAtypIPv4      = 0x01
	socksAtypDomain    = 0x03
	socksAtypIPv6      = 0x04

	socksReplySucceeded       = 0x00
	socksReplyGeneralFailure  = 0x01
	socksReplyNetworkUnreach  = 0x03
	socksReplyHostUnreach     = 0x04
	socksReplyCommandNotSupp  = 0x07
	socksReplyAtypNotSupp     = 0x08

	socksHandshakeTimeout = 10 * time.Second
	socksDialTimeout      = 25 * time.Second
)

var errNoExitReady = errors.New("warp lane has no ready exit")

// serveSOCKS5 accepts CONNECT requests on ln and dials every one of them
// through lane's current WARP exit. The listener outlives rotations: a lane
// swaps its exit in place, so the gateway keeps the same proxy URL.
func serveSOCKS5(ln net.Listener, lane *lane) {
	for {
		client, err := ln.Accept()
		if err != nil {
			return
		}
		go handleSocksClient(client, lane)
	}
}

func handleSocksClient(client net.Conn, lane *lane) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(socksHandshakeTimeout))

	if err := socksGreeting(client); err != nil {
		return
	}
	target, err := socksRequest(client)
	if err != nil {
		return
	}

	current := lane.current()
	if current == nil {
		_ = writeSocksReply(client, socksReplyGeneralFailure)
		lane.failures.Add(1)
		return
	}

	_ = client.SetDeadline(time.Now().Add(socksDialTimeout))
	upstream, err := current.dialContext(context.Background(), "tcp", target)
	if err != nil {
		_ = writeSocksReply(client, socksReplyHostUnreach)
		lane.failures.Add(1)
		return
	}
	defer upstream.Close()
	lane.dials.Add(1)

	if err := writeSocksReply(client, socksReplySucceeded); err != nil {
		return
	}
	_ = client.SetDeadline(time.Time{})

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, client)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		done <- struct{}{}
	}()
	<-done
}

func socksGreeting(client net.Conn) error {
	header := make([]byte, 2)
	if _, err := io.ReadFull(client, header); err != nil {
		return err
	}
	if header[0] != socksVersion {
		return errors.New("unsupported SOCKS version")
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return err
	}
	for _, method := range methods {
		if method == socksNoAuth {
			_, err := client.Write([]byte{socksVersion, socksNoAuth})
			return err
		}
	}
	_, _ = client.Write([]byte{socksVersion, 0xFF})
	return errors.New("no supported SOCKS auth method")
}

func socksRequest(client net.Conn) (string, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(client, header); err != nil {
		return "", err
	}
	if header[0] != socksVersion {
		return "", errors.New("unsupported SOCKS version")
	}
	if header[1] != socksCommandConnect {
		_ = writeSocksReply(client, socksReplyCommandNotSupp)
		return "", errors.New("unsupported SOCKS command")
	}
	var host string
	switch header[3] {
	case socksAtypIPv4:
		buf := make([]byte, 4)
		if _, err := io.ReadFull(client, buf); err != nil {
			return "", err
		}
		host = net.IP(buf).String()
	case socksAtypIPv6:
		buf := make([]byte, 16)
		if _, err := io.ReadFull(client, buf); err != nil {
			return "", err
		}
		host = net.IP(buf).String()
	case socksAtypDomain:
		length := make([]byte, 1)
		if _, err := io.ReadFull(client, length); err != nil {
			return "", err
		}
		buf := make([]byte, int(length[0]))
		if _, err := io.ReadFull(client, buf); err != nil {
			return "", err
		}
		host = string(buf)
	default:
		_ = writeSocksReply(client, socksReplyAtypNotSupp)
		return "", errors.New("unsupported SOCKS address type")
	}
	portBuf := make([]byte, 2)
	if _, err := io.ReadFull(client, portBuf); err != nil {
		return "", err
	}
	port := binary.BigEndian.Uint16(portBuf)
	return net.JoinHostPort(strings.TrimSpace(host), strconv.Itoa(int(port))), nil
}

func writeSocksReply(client net.Conn, code byte) error {
	// BND.ADDR is reported as 0.0.0.0:0; clients only use it for BIND.
	_, err := client.Write([]byte{socksVersion, code, 0x00, socksAtypIPv4, 0, 0, 0, 0, 0, 0})
	return err
}
