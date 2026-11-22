package api

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"

	"github.com/riba2534/passkey-box/server/internal/store"
)

const (
	algES256 = -7
	algRS256 = -257
)

type credentialRequest struct {
	ID              string `json:"id"`
	RPID            string `json:"rp_id"`
	RPName          string `json:"rp_name"`
	UserHandle      string `json:"user_handle"`
	UserName        string `json:"user_name"`
	UserDisplayName string `json:"user_display_name"`
	Alg             *int   `json:"alg"`
	PrivateKey      string `json:"private_key"`
	PublicKey       string `json:"public_key"`
	SignCount       int64  `json:"sign_count"`
	Label           string `json:"label"`
	Origin          string `json:"origin"`
}

// isHTTPURL reports whether s is an absolute http or https URL.
func isHTTPURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func isBase64URL(s string) bool {
	_, err := base64.RawURLEncoding.DecodeString(s)
	return err == nil
}

// validate checks the request and returns an error message, or "" if valid.
func (c *credentialRequest) validate() string {
	c.RPID = strings.TrimSpace(c.RPID)
	switch {
	case c.ID == "" || !isBase64URL(c.ID):
		return "id must be a non-empty base64url string"
	case c.RPID == "":
		return "rp_id is required"
	case c.UserHandle == "" || !isBase64URL(c.UserHandle):
		return "user_handle must be a non-empty base64url string"
	case c.PrivateKey == "" || !isBase64URL(c.PrivateKey):
		return "private_key must be a non-empty base64url string"
	case !isBase64URL(c.PublicKey):
		return "public_key must be a base64url string"
	case c.Alg == nil || (*c.Alg != algES256 && *c.Alg != algRS256):
		return "alg must be -7 or -257"
	case c.SignCount < 0:
		return "sign_count must not be negative"
	case c.Origin != "" && !isHTTPURL(c.Origin):
		return "origin must be an http or https URL"
	}
	return ""
}

// credentialAccess parses the access query parameter: all (the default),
// owned or shared. It answers 400 and returns false for other values.
func credentialAccess(w http.ResponseWriter, r *http.Request) (string, bool) {
	switch r.URL.Query().Get("access") {
	case "", "all":
		return "", true
	case "owned":
		return store.AccessOwner, true
	case "shared":
		return store.AccessShared, true
	default:
		badRequest(w, "access must be all, owned or shared")
		return "", false
	}
}

func (s *Server) handleListCredentials(w http.ResponseWriter, r *http.Request, c *caller) {
	s.writeCredentials(w, r, c.User.ID, c.privateKeys(), false)
}

// writeCredentials answers the credentials the user owns or that are shared
// with them, filtered by the rp_id and access query parameters. Shares are
// listed for the owner and, with admin, for every credential.
func (s *Server) writeCredentials(w http.ResponseWriter, r *http.Request, userID int64, privateKeys, admin bool) {
	access, ok := credentialAccess(w, r)
	if !ok {
		return
	}
	creds, err := s.opts.Store.ListAccessibleCredentials(r.Context(), userID, store.AccessFilter{
		RPID:   strings.TrimSpace(r.URL.Query().Get("rp_id")),
		Access: access,
	})
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credentials": newAccessCredentialViews(creds, privateKeys, admin)})
}

func (s *Server) handleCreateCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	var req credentialRequest
	if !readJSON(w, r, &req) {
		return
	}
	if msg := req.validate(); msg != "" {
		badRequest(w, msg)
		return
	}
	cred, err := s.opts.Store.SaveCredential(r.Context(), c.actor(), c.User.ID, store.Credential{
		ID:              req.ID,
		RPID:            req.RPID,
		RPName:          req.RPName,
		UserHandle:      req.UserHandle,
		UserName:        req.UserName,
		UserDisplayName: req.UserDisplayName,
		Alg:             *req.Alg,
		PrivateKey:      req.PrivateKey,
		PublicKey:       req.PublicKey,
		SignCount:       req.SignCount,
		Label:           req.Label,
		Origin:          req.Origin,
	}, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, credentialNotFound)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"credential": newAccessCredentialView(cred, c.privateKeys(), false)})
}

func (s *Server) handleGetCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	cred, err := s.opts.Store.GetCredential(r.Context(), c.User.ID, r.PathValue("id"))
	if err != nil {
		s.writeStoreError(w, err, credentialNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credential": newAccessCredentialView(cred, c.privateKeys(), false)})
}

// readCredentialUpdate reads the body of PATCH /credentials/{id} and
// /admin/credentials/{id}, where every member is optional; the store checks
// the values. On failure it answers 400 and returns false.
func readCredentialUpdate(w http.ResponseWriter, r *http.Request) (store.CredentialUpdate, bool) {
	var req struct {
		Label           *string        `json:"label"`
		RPName          *string        `json:"rp_name"`
		UserName        *string        `json:"user_name"`
		UserDisplayName *string        `json:"user_display_name"`
		Fields          *[]store.Field `json:"fields"`
	}
	if !readJSON(w, r, &req) {
		return store.CredentialUpdate{}, false
	}
	return store.CredentialUpdate{Label: req.Label, RPName: req.RPName, UserName: req.UserName,
		UserDisplayName: req.UserDisplayName, Fields: req.Fields}, true
}

func (s *Server) handleUpdateCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	u, ok := readCredentialUpdate(w, r)
	if !ok {
		return
	}
	cred, err := s.opts.Store.UpdateCredential(r.Context(), c.actor(), c.User.ID, r.PathValue("id"), u, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, credentialNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credential": newAccessCredentialView(cred, c.privateKeys(), false)})
}

func (s *Server) handleUseCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	err := s.opts.Store.MarkCredentialUsed(r.Context(), c.User.ID, r.PathValue("id"), s.opts.Now())
	s.writeNoContent(w, err, credentialNotFound)
}

func (s *Server) handleDeleteCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	err := s.opts.Store.DeleteCredential(r.Context(), c.actor(), c.User.ID, r.PathValue("id"), s.opts.Now())
	s.writeNoContent(w, err, credentialNotFound)
}

func credentialNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "credential not found")
}
