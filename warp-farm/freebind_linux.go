//go:build linux

package main

import "syscall"

// ipv6FREEBIND 是 IPV6_FREEBIND（Linux 2.6.22+）：允许 socket 绑定一个已路由
// 到本机、但未分配给任何接口的 IPv6 源地址。
// golang.org/x/sys/unix 尚未导出该常量。
const ipv6FREEBIND = 78

func freebindControl(_, _ string, raw syscall.RawConn) error {
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		sockErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IPV6, ipv6FREEBIND, 1)
	}); err != nil {
		return err
	}
	return sockErr
}
