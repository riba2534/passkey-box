package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/riba2534/passkey-box/server/internal/store"
)

// authMethod is how a request authenticated.
type authMethod string

const (
	authBasic   authMethod = "basic"
	authSession authMethod = "session"
	authToken   authMethod = "token"
)

// caller is the authenticated user of a request.
type caller struct {
	User   store.User
	Method authMethod
	// Token is the API token of a token-authenticated request.
	Token *store.APIToken
}

// actor names the caller in audit events.
func (c *caller) actor() store.Actor {
	via := string(c.Method)
	if c.Token != nil {
		via = "token:" + c.Token.Name
	}
	return store.Actor{ID: c.User.ID, Name: c.User.Username, Via: via}
}

// privateKeys reports whether responses may carry credential private keys.
// Only HTTP Basic, which the extension uses to sign, gets them; sessions and
// API tokens never do.
func (c *caller) privateKeys() bool { return c.Method == authBasic }

// readOnly reports a read-only API token.
func (c *caller) readOnly() bool { return c.Token != nil && c.Token.ReadOnly }

type authedHandler func(w http.ResponseWriter, r *http.Request, c *caller)

var errUnauthorized = errors.New("unauthorized")

// authScheme splits the Authorization header into its scheme, in lower case,
// and the credentials after it.
func authScheme(r *http.Request) (scheme, credentials string) {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if i := strings.IndexAny(h, " \t"); i >= 0 {
		return strings.ToLower(h[:i]), strings.TrimSpace(h[i+1:])
	}
	return strings.ToLower(h), ""
}

// crossSite reports a request a browser sent on behalf of another site, by
// Sec-Fetch-Site or, from browsers without it, Origin.
func crossSite(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		return site != "same-origin" && site != "none"
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		return err != nil || !strings.EqualFold(u.Host, r.Host)
	}
	return false
}

// currentCaller resolves the caller. An Authorization header with the Basic
// or Bearer scheme takes precedence over the session cookie; a failing or
// malformed one is not retried with the cookie.
func (s *Server) currentCaller(r *http.Request) (*caller, error) {
	ctx := r.Context()
	scheme, secret := authScheme(r)
	if scheme == "basic" {
		username, password, ok := r.BasicAuth()
		if !ok {
			return nil, errUnauthorized
		}
		user, err := s.opts.Store.Authenticate(ctx, username, password)
		if errors.Is(err, store.ErrBadPassword) {
			return nil, errUnauthorized
		}
		if err != nil {
			return nil, err
		}
		return &caller{User: user, Method: authBasic}, nil
	}
	if scheme == "bearer" {
		user, token, err := s.opts.Store.TokenUser(ctx, secret, s.opts.Now())
		if errors.Is(err, store.ErrNotFound) {
			return nil, errUnauthorized
		}
		if err != nil {
			return nil, err
		}
		return &caller{User: user, Method: authToken, Token: &token}, nil
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil, errUnauthorized
	}
	user, err := s.opts.Store.SessionUser(ctx, c.Value, s.opts.Now())
	if errors.Is(err, store.ErrNotFound) {
		return nil, errUnauthorized
	}
	if err != nil {
		return nil, err
	}
	return &caller{User: user, Method: authSession}, nil
}

func accountDisabled(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "account_disabled", "this account is disabled")
}

// authed requires a logged-in, active user. Read-only API tokens may only
// read.
func (s *Server) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := s.currentCaller(r)
		if err != nil {
			if errors.Is(err, errUnauthorized) {
				writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
				return
			}
			s.internalError(w, err)
			return
		}
		if c.User.Disabled {
			accountDisabled(w)
			return
		}
		// The browser attaches the session cookie to requests other sites
		// make, too (SameSite=Lax still covers sibling subdomains).
		if c.Method == authSession && r.Method != http.MethodGet && r.Method != http.MethodHead && crossSite(r) {
			writeError(w, http.StatusForbidden, "forbidden", "cross-site request refused")
			return
		}
		if c.readOnly() && r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusForbidden, "read_only_token", "this API token can only read")
			return
		}
		next(w, r, c)
	}
}

// admin requires a logged-in administrator.
func (s *Server) admin(next authedHandler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, c *caller) {
		if !c.User.IsAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "administrator required")
			return
		}
		next(w, r, c)
	})
}

// sessionOnly rejects API tokens: they must not manage tokens or change the
// password, which would let a leaked token renew itself.
func (s *Server) sessionOnly(next authedHandler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, c *caller) {
		if c.Method == authToken {
			writeError(w, http.StatusForbidden, "token_not_allowed", "this endpoint does not accept API tokens; sign in with a password")
			return
		}
		next(w, r, c)
	})
}
