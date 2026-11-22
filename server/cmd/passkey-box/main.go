// Command passkey-box runs the Passkey Box server: the HTTP API used by the
// browser extension and the embedded web console.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/riba2534/passkey-box/server/internal/api"
	"github.com/riba2534/passkey-box/server/internal/config"
	"github.com/riba2534/passkey-box/server/internal/store"
	"github.com/riba2534/passkey-box/server/internal/web"
)

// version is set at build time with -ldflags "-X main.version=<v>".
var version = "dev"

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()
	if m := st.Migration; m.From != m.To {
		if m.Snapshot != "" {
			log.Printf("migrated database schema %d -> %d; copy of the previous database: %s", m.From, m.To, m.Snapshot)
		} else {
			log.Printf("initialised database schema %d", m.To)
		}
	}

	if cfg.BootstrapAdmin() {
		created, err := st.EnsureAdmin(context.Background(), cfg.AdminUsername, cfg.AdminPassword, time.Now())
		if err != nil {
			return err
		}
		if created {
			log.Printf("created administrator %q", cfg.AdminUsername)
		}
	}

	handler := api.New(api.Options{
		Store:         st,
		Version:       version,
		AllowRegister: cfg.AllowRegister,
		CookieSecure:  cfg.CookieSecure,
		ExtensionZip:  cfg.ExtensionZip,
		Web:           web.Handler(),
	})
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	log.Printf("passkey-box %s listening on %s (database %s)", version, ln.Addr(), cfg.DBPath)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	log.Print("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
