// Package api implements the HTTP API described in docs/API.md and mounts the
// web console.
package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/riba2534/passkey-box/server/internal/store"
)

const (
	sessionCookie   = "pkb_session"
	sessionLifetime = 30 * 24 * time.Hour
	maxBodyBytes    = 1 << 20
	extensionPath   = "/downloads/passkey-box-extension.zip"
	extensionName   = "passkey-box-extension.zip"
)

// Options configures a Server.
type Options struct {
	Store         *store.Store
	Version       string
	AllowRegister bool
	CookieSecure  bool
	ExtensionZip  string           // path of the extension package; empty disables downloads
	Web           http.Handler     // serves the web console for all non-API paths; may be nil
	Now           func() time.Time // defaults to time.Now
}

// Server is the HTTP handler for the whole application.
type Server struct {
	opts Options
	mux  *http.ServeMux
}

// New builds a Server.
func New(opts Options) *Server {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Server{opts: opts, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /healthz", s.handleHealth)
	m.HandleFunc("GET "+extensionPath, s.handleExtensionDownload)

	m.HandleFunc("GET /api/v1/info", s.handleInfo)
	m.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	m.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	m.HandleFunc("POST /api/v1/auth/register", s.handleRegister)

	m.HandleFunc("GET /api/v1/me", s.authed(s.handleMe))
	m.HandleFunc("PUT /api/v1/me/password", s.authed(s.handleChangePassword))

	m.HandleFunc("GET /api/v1/credentials", s.authed(s.handleListCredentials))
	m.HandleFunc("POST /api/v1/credentials", s.authed(s.handleCreateCredential))
	m.HandleFunc("PATCH /api/v1/credentials/{id}", s.authed(s.handleUpdateCredential))
	m.HandleFunc("POST /api/v1/credentials/{id}/use", s.authed(s.handleUseCredential))
	m.HandleFunc("DELETE /api/v1/credentials/{id}", s.authed(s.handleDeleteCredential))

	m.HandleFunc("GET /api/v1/admin/users", s.admin(s.handleAdminListUsers))
	m.HandleFunc("POST /api/v1/admin/users", s.admin(s.handleAdminCreateUser))
	m.HandleFunc("PATCH /api/v1/admin/users/{user_id}", s.admin(s.handleAdminUpdateUser))
	m.HandleFunc("DELETE /api/v1/admin/users/{user_id}", s.admin(s.handleAdminDeleteUser))
	m.HandleFunc("GET /api/v1/admin/users/{user_id}/credentials", s.admin(s.handleAdminListCredentials))
	m.HandleFunc("DELETE /api/v1/admin/users/{user_id}/credentials/{id}", s.admin(s.handleAdminDeleteCredential))
	m.HandleFunc("/api/v1/admin/", s.admin(func(w http.ResponseWriter, r *http.Request, _ store.User) {
		writeError(w, http.StatusNotFound, "not_found", "endpoint not found")
	}))

	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "endpoint not found")
	})

	// "/" must not carry a method: "GET /" would conflict with "/api/".
	if s.opts.Web != nil {
		m.Handle("/", s.opts.Web)
	}
}

// ServeHTTP applies CORS to /api/* and dispatches the request.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		h.Set("Access-Control-Max-Age", "86400")
		h.Set("Cache-Control", "no-store")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	s.mux.ServeHTTP(w, r)
}

type authedHandler func(w http.ResponseWriter, r *http.Request, user store.User)

// authed requires a logged-in user (HTTP Basic or session cookie).
func (s *Server) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := s.currentUser(r)
		if err != nil {
			if errors.Is(err, errUnauthorized) {
				writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
				return
			}
			s.internalError(w, err)
			return
		}
		next(w, r, user)
	}
}

// admin requires a logged-in administrator.
func (s *Server) admin(next authedHandler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, user store.User) {
		if !user.IsAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "administrator required")
			return
		}
		next(w, r, user)
	})
}

var errUnauthorized = errors.New("unauthorized")

// currentUser resolves the caller. A Basic Authorization header takes
// precedence over the session cookie; a failing Basic header is not retried
// with the cookie.
func (s *Server) currentUser(r *http.Request) (store.User, error) {
	ctx := r.Context()
	if username, password, ok := r.BasicAuth(); ok {
		user, err := s.opts.Store.Authenticate(ctx, username, password)
		if errors.Is(err, store.ErrBadPassword) {
			return store.User{}, errUnauthorized
		}
		return user, err
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return store.User{}, errUnauthorized
	}
	user, err := s.opts.Store.SessionUser(ctx, c.Value, s.opts.Now())
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, errUnauthorized
	}
	return user, err
}

// startSession creates a session for the user and sets the cookie.
func (s *Server) startSession(w http.ResponseWriter, r *http.Request, user store.User) error {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	now := s.opts.Now()
	expires := now.Add(sessionLifetime)
	if err := s.opts.Store.CreateSession(r.Context(), token, user.ID, now, expires); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(sessionLifetime / time.Second),
		HttpOnly: true,
		Secure:   s.opts.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.opts.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": s.opts.Version})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":            s.opts.Version,
		"allow_register":     s.opts.AllowRegister,
		"extension_download": s.extensionFile() != nil,
	})
}

// extensionFile returns the extension package info, or nil if unavailable.
func (s *Server) extensionFile() os.FileInfo {
	if s.opts.ExtensionZip == "" {
		return nil
	}
	fi, err := os.Stat(s.opts.ExtensionZip)
	if err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	return fi
}

func (s *Server) handleExtensionDownload(w http.ResponseWriter, r *http.Request) {
	if s.extensionFile() == nil {
		writeError(w, http.StatusNotFound, "not_found", "extension package not available")
		return
	}
	f, err := os.Open(s.opts.ExtensionZip)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "extension package not available")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		writeError(w, http.StatusNotFound, "not_found", "extension package not available")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+extensionName+`"`)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, extensionName, fi.ModTime(), f)
}

// decodeJSON reads a single JSON value from the request body into v.
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("unexpected data after JSON value")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}

func badRequest(w http.ResponseWriter, message string) {
	writeError(w, http.StatusBadRequest, "invalid_request", message)
}

func (s *Server) internalError(w http.ResponseWriter, err error) {
	log.Printf("internal error: %v", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal server error")
}
