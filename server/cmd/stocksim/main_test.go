package main

import (
	"net"
	"path/filepath"
	"testing"
)

// A failed listener must be reported to the process supervisor instead of appearing to exit successfully.
func TestRunReportsListenFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	t.Setenv("STOCKSIM_ADDR", listener.Addr().String())
	t.Setenv("STOCKSIM_DB", filepath.Join(t.TempDir(), "listen.db"))
	if err = run(); err == nil {
		t.Fatal("occupied listen address was reported as success")
	}
}
