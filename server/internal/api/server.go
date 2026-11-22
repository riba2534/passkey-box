// Package api implements the HTTP API described in docs/API.md and mounts the
// web console.
package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	// maxCredentialUpdateBytes fits the largest valid credential update: 50
	// fields of 10000 characters each, even with every character JSON-escaped
	// as a surrogate pair (12 bytes). Only the PATCH endpoints accept it.
	maxCredentialUpdateBytes = 8 << 20
	extensionPath            = "/downloads/passkey-box-extension.zip"
	extensionName            = "passkey-box-extension.zip"
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

// route is an HTTP route: a ServeMux pattern and its handler.
type route struct {
	pattern string
	handler http.HandlerFunc
}

// routeTable lists every route. docs/API.md and /skill.md must document each
// /api/v1 pattern (see TestRoutesAreDocumented).
func (s *Server) routeTable() []route {
	return []route{
		{"GET /healthz", s.handleHealth},
		{"GET " + extensionPath, s.handleExtensionDownload},
		{"GET /skill.md", s.handleSkill},

		{"GET /api/v1/info", s.handleInfo},
		{"POST /api/v1/auth/login", s.handleLogin},
		{"POST /api/v1/auth/logout", s.handleLogout},
		{"POST /api/v1/auth/register", s.handleRegister},

		{"GET /api/v1/me", s.authed(s.handleMe)},
		{"PUT /api/v1/me/password", s.sessionOnly(s.handleChangePassword)},
		{"GET /api/v1/me/tokens", s.sessionOnly(s.handleListTokens)},
		{"POST /api/v1/me/tokens", s.sessionOnly(s.handleCreateToken)},
		{"DELETE /api/v1/me/tokens/{token_id}", s.sessionOnly(s.handleDeleteToken)},
		{"GET /api/v1/me/activity", s.authed(s.handleMyActivity)},
		{"GET /api/v1/users", s.authed(s.handleUserDirectory)},

		{"GET /api/v1/credentials", s.authed(s.handleListCredentials)},
		{"POST /api/v1/credentials", s.authed(s.handleCreateCredential)},
		{"POST /api/v1/credentials/share", s.authed(scoped(s.shareCredentials, false))},
		{"POST /api/v1/credentials/unshare", s.authed(scoped(s.unshareCredentials, false))},
		{"POST /api/v1/credentials/transfer", s.authed(scoped(s.transferCredentials, false))},
		{"POST /api/v1/credentials/leave", s.authed(s.handleLeave)},
		{"POST /api/v1/credentials/batch-delete", s.authed(scoped(s.deleteCredentials, false))},
		{"GET /api/v1/credentials/{id}", s.authed(s.handleGetCredential)},
		{"PATCH /api/v1/credentials/{id}", s.authed(s.handleUpdateCredential)},
		{"POST /api/v1/credentials/{id}/use", s.authed(s.handleUseCredential)},
		{"DELETE /api/v1/credentials/{id}", s.authed(s.handleDeleteCredential)},

		{"GET /api/v1/admin/overview", s.admin(s.handleAdminOverview)},
		{"GET /api/v1/admin/audit", s.admin(s.handleAdminAudit)},
		{"GET /api/v1/admin/users", s.admin(s.handleAdminListUsers)},
		{"POST /api/v1/admin/users", s.admin(s.handleAdminCreateUser)},
		{"POST /api/v1/admin/users/batch-create", s.admin(s.handleAdminBatchCreateUsers)},
		{"POST /api/v1/admin/users/batch-update", s.admin(s.handleAdminBatchUpdateUsers)},
		{"POST /api/v1/admin/users/batch-delete", s.admin(s.handleAdminBatchDeleteUsers)},
		{"GET /api/v1/admin/users/{user_id}", s.admin(s.handleAdminGetUser)},
		{"PATCH /api/v1/admin/users/{user_id}", s.admin(s.handleAdminUpdateUser)},
		{"DELETE /api/v1/admin/users/{user_id}", s.admin(s.handleAdminDeleteUser)},
		{"POST /api/v1/admin/users/{user_id}/revoke-sessions", s.admin(s.handleAdminRevokeSessions)},
		{"GET /api/v1/admin/users/{user_id}/credentials", s.admin(s.handleAdminListUserCredentials)},
		{"DELETE /api/v1/admin/users/{user_id}/credentials/{id}", s.admin(s.handleAdminDeleteUserCredential)},
		{"GET /api/v1/admin/credentials", s.admin(s.handleAdminListCredentials)},
		{"POST /api/v1/admin/credentials/share", s.admin(scoped(s.shareCredentials, true))},
		{"POST /api/v1/admin/credentials/unshare", s.admin(scoped(s.unshareCredentials, true))},
		{"POST /api/v1/admin/credentials/transfer", s.admin(scoped(s.transferCredentials, true))},
		{"POST /api/v1/admin/credentials/batch-delete", s.admin(scoped(s.deleteCredentials, true))},
		{"GET /api/v1/admin/credentials/{id}", s.admin(s.handleAdminGetCredential)},
		{"PATCH /api/v1/admin/credentials/{id}", s.admin(s.handleAdminUpdateCredential)},
		{"DELETE /api/v1/admin/credentials/{id}", s.admin(s.handleAdminDeleteCredential)},
	}
}

func (s *Server) routes() {
	m := s.mux
	for _, rt := range s.routeTable() {
		m.HandleFunc(rt.pattern, rt.handler)
	}
	m.HandleFunc("/api/v1/admin/", s.admin(func(w http.ResponseWriter, r *http.Request, _ *caller) {
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
		"skill_url":          "/skill.md",
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
	// An empty ExtensionZip fails to open, so it is reported like a missing file.
	f, err := os.Open(s.opts.ExtensionZip)
	var fi os.FileInfo
	if err == nil {
		defer f.Close()
		fi, err = f.Stat()
	}
	if err != nil || !fi.Mode().IsRegular() {
		writeError(w, http.StatusNotFound, "not_found", "extension package not available")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+extensionName+`"`)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, extensionName, fi.ModTime(), f)
}

// readJSON reads a single JSON value from the request body into v. On failure
// it answers 400 and returns false.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return readJSONLimit(w, r, v, maxBodyBytes)
}

// readJSONLimit is readJSON with a body of at most limit bytes; a larger body
// answers 413.
func readJSONLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	err := dec.Decode(v)
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "invalid_request", fmt.Sprintf("request body exceeds %d bytes", limit))
		return false
	}
	if err != nil || dec.More() {
		badRequest(w, "invalid JSON body")
		return false
	}
	return true
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
	// Items lists the failed entries of a batch request.
	Items []store.ItemError `json:"items,omitempty"`
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
