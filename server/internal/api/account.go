package api

import (
	"errors"
	"net/http"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// validUsername checks the username rule from docs/API.md.
func validUsername(w http.ResponseWriter, username string) bool {
	if _, _, ok := store.NormalizeUsername(username); !ok {
		badRequest(w, "username must be 1-64 characters")
		return false
	}
	return true
}

// validPassword checks the password rule from docs/API.md.
func validPassword(w http.ResponseWriter, password string) bool {
	if password == "" {
		badRequest(w, "password must not be empty")
		return false
	}
	return true
}

// createUser creates the account on behalf of actor. It writes the error
// response and returns false on failure.
func (s *Server) createUser(w http.ResponseWriter, r *http.Request, actor store.Actor, u store.NewUser) (store.User, bool) {
	user, err := s.opts.Store.CreateUserAs(r.Context(), actor, u, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, userNotFound)
		return store.User{}, false
	}
	return user, true
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !readJSON(w, r, &req) {
		return
	}
	if !validUsername(w, req.Username) || !validPassword(w, req.Password) {
		return
	}
	user, err := s.opts.Store.Authenticate(r.Context(), req.Username, req.Password)
	if errors.Is(err, store.ErrBadPassword) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "invalid username or password")
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	if user.Disabled {
		accountDisabled(w)
		return
	}
	if err := s.startSession(w, r, user); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": newUserView(user)})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		if err := s.opts.Store.DeleteSession(r.Context(), c.Value); err != nil {
			s.internalError(w, err)
			return
		}
	}
	s.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.opts.AllowRegister {
		writeError(w, http.StatusForbidden, "registration_disabled", "self-registration is disabled")
		return
	}
	var req loginRequest
	if !readJSON(w, r, &req) {
		return
	}
	// Nobody is signed in yet, so the account is created by the system.
	user, ok := s.createUser(w, r, store.SystemActor, store.NewUser{Username: req.Username, Password: req.Password})
	if !ok {
		return
	}
	if err := s.startSession(w, r, user); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": newUserView(user)})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, c *caller) {
	auth := map[string]any{"method": c.Method, "read_only": c.readOnly(), "token": nil}
	if c.Token != nil {
		auth["token"] = newTokenView(*c.Token)
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": newUserView(c.User), "auth": auth})
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request, c *caller) {
	user := c.User
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validPassword(w, req.NewPassword) {
		return
	}
	err := s.opts.Store.CheckPassword(r.Context(), user.ID, req.OldPassword)
	if errors.Is(err, store.ErrBadPassword) {
		writeError(w, http.StatusBadRequest, "invalid_password", "old password is incorrect")
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	_, err = s.opts.Store.UpdateUser(r.Context(), c.actor(), user.ID, store.UserUpdate{Password: &req.NewPassword}, s.opts.Now())
	s.writeNoContent(w, err, userNotFound)
}
