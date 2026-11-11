//go:build !linux

package main

import "syscall"

// freebindControl 在 Linux 之外是空操作：配置的源地址必须已分配给某个接口。
func freebindControl(_, _ string, _ syscall.RawConn) error { return nil }
