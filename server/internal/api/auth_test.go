package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/riba2534/passkey-box/server/internal/api"
	"github.com/riba2534/passkey-box/server/internal/store"
)

func TestBasicAuth(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("Alice", "secret", false)

	u := e.basic("Alice", "secret").do("GET", "/api/v1/me", nil).expect(http.StatusOK).user()
	if u.ID != alice.ID || u.Username != "Alice" || u.IsAdmin {
		t.Fatalf("me = %+v", u)
	}
	if u.CreatedAt != "2026-11-20T03:30:00Z" || u.CredentialCount != 0 || u.LastUsedAt != nil {
		t.Fatalf("me = %+v", u)
	}

	// Usernames are trimmed and case-insensitive.
	e.basic("  aLICE ", "secret").do("GET", "/api/v1/me", nil).expect(http.StatusOK)

	for name, c := range map[string]*client{
		"wrong password": e.basic("Alice", "Secret"),
		"unknown user":   e.basic("bob", "secret"),
		"no credentials": e.anon(),
	} {
		t.Run(name, func(t *testing.T) {
			r := c.do("GET", "/api/v1/me", nil)
			r.expectError(http.StatusUnauthorized, "unauthorized")
			if h := r.header.Get("WWW-Authenticate"); h != "" {
				t.Fatalf("401 carries WWW-Authenticate %q", h)
			}
		})
	}
}

func TestBasicAuthFailureIgnoresCookie(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "secret", false)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "secret"}).expect(http.StatusOK)
	b.basic, b.user, b.pass = true, "alice", "wrong"
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestCookieLoginLogout(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "secret", false)
	b := e.browser()

	r := b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "nope"})
	r.expectError(http.StatusUnauthorized, "unauthorized")
	if r.header.Get("WWW-Authenticate") != "" || sessionCookieFrom(r) != nil {
		t.Fatalf("failed login set headers: %v", r.header)
	}
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "ghost", "password": "secret"}).
		expectError(http.StatusUnauthorized, "unauthorized")
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")

	r = b.do("POST", "/api/v1/auth/login", map[string]string{"username": "ALICE", "password": "secret"}).expect(http.StatusOK)
	if u := r.user(); u.Username != "alice" {
		t.Fatalf("login user = %+v", u)
	}
	c := sessionCookieFrom(r)
	if c == nil {
		t.Fatal("login did not set pkb_session")
	}
	if !c.HttpOnly || c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.MaxAge != 30*24*3600 {
		t.Fatalf("cookie = %+v", c)
	}

	b.do("GET", "/api/v1/me", nil).expect(http.StatusOK)

	r = b.do("POST", "/api/v1/auth/logout", nil).expect(http.StatusNoContent)
	if c := sessionCookieFrom(r); c == nil || c.MaxAge >= 0 {
		t.Fatalf("logout cookie = %+v", c)
	}
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")

	// Logging out without a session is still fine.
	b.do("POST", "/api/v1/auth/logout", nil).expect(http.StatusNoContent)
	e.anon().do("POST", "/api/v1/auth/logout", nil).expect(http.StatusNoContent)
}

func TestLogoutInvalidatesSessionToken(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "secret", false)
	r := e.anon().do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "secret"}).expect(http.StatusOK)
	token := sessionCookieFrom(r).Value

	withCookie := func(method, path string) *http.Response {
		req, _ := http.NewRequest(method, e.srv.URL+path, nil)
		req.AddCookie(&http.Cookie{Name: "pkb_session", Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}
	if res := withCookie("GET", "/api/v1/me"); res.StatusCode != http.StatusOK {
		t.Fatalf("me = %d", res.StatusCode)
	}
	withCookie("POST", "/api/v1/auth/logout")
	if res := withCookie("GET", "/api/v1/me"); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me after logout = %d", res.StatusCode)
	}
}

func TestSecureCookie(t *testing.T) {
	e := newEnv(t, func(o *api.Options) { o.CookieSecure = true })
	e.createUser("alice", "secret", false)
	r := e.anon().do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "secret"}).expect(http.StatusOK)
	if c := sessionCookieFrom(r); c == nil || !c.Secure {
		t.Fatalf("cookie = %+v, want Secure", c)
	}
}

func TestSessionExpiresAfter30Days(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "secret", false)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "secret"}).expect(http.StatusOK)

	e.advance(30*24*time.Hour - time.Minute)
	b.do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.advance(2 * time.Minute)
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestLoginValidation(t *testing.T) {
	e := newEnv(t)
	c := e.anon()
	c.do("POST", "/api/v1/auth/login", "{not json").expectError(http.StatusBadRequest, "invalid_request")
	c.do("POST", "/api/v1/auth/login", nil).expectError(http.StatusBadRequest, "invalid_request")
	c.do("POST", "/api/v1/auth/login", map[string]string{"username": "  ", "password": "x"}).expectError(http.StatusBadRequest, "invalid_request")
	c.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice"}).expectError(http.StatusBadRequest, "invalid_request")
}

func TestRegister(t *testing.T) {
	t.Run("disabled", func(t *testing.T) {
		e := newEnv(t)
		e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": "carol", "password": "pw"}).
			expectError(http.StatusForbidden, "registration_disabled")
		var info map[string]any
		e.anon().do("GET", "/api/v1/info", nil).expect(http.StatusOK).decode(&info)
		if info["allow_register"] != false {
			t.Fatalf("info = %v", info)
		}
		if _, err := e.store.Authenticate(t.Context(), "carol", "pw"); err == nil {
			t.Fatal("user was created although registration is disabled")
		}
	})

	t.Run("enabled", func(t *testing.T) {
		e := newEnv(t, func(o *api.Options) { o.AllowRegister = true })
		var info map[string]any
		e.anon().do("GET", "/api/v1/info", nil).expect(http.StatusOK).decode(&info)
		if info["allow_register"] != true {
			t.Fatalf("info = %v", info)
		}

		b := e.browser()
		r := b.do("POST", "/api/v1/auth/register", map[string]string{"username": " Carol ", "password": "pw"}).expect(http.StatusCreated)
		u := r.user()
		if u.Username != "Carol" || u.IsAdmin {
			t.Fatalf("registered user = %+v", u)
		}
		if sessionCookieFrom(r) == nil {
			t.Fatal("register did not set a session cookie")
		}
		b.do("GET", "/api/v1/me", nil).expect(http.StatusOK)
		e.basic("carol", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)

		e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": "CAROL", "password": "x"}).
			expectError(http.StatusConflict, "conflict")
		e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": "", "password": "x"}).
			expectError(http.StatusBadRequest, "invalid_request")
		e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": "dave", "password": ""}).
			expectError(http.StatusBadRequest, "invalid_request")
	})
}

func TestUsernameLength(t *testing.T) {
	e := newEnv(t, func(o *api.Options) { o.AllowRegister = true })
	name64 := ""
	for range 64 {
		name64 += "名"
	}
	e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": name64, "password": "pw"}).expect(http.StatusCreated)
	e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": name64 + "x", "password": "pw"}).
		expectError(http.StatusBadRequest, "invalid_request")
}

func TestChangePassword(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "old", false)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "old"}).expect(http.StatusOK)

	b.do("PUT", "/api/v1/me/password", map[string]string{"old_password": "wrong", "new_password": "new"}).
		expectError(http.StatusBadRequest, "invalid_password")
	b.do("PUT", "/api/v1/me/password", map[string]string{"old_password": "old", "new_password": ""}).
		expectError(http.StatusBadRequest, "invalid_request")
	b.do("PUT", "/api/v1/me/password", "[]").expectError(http.StatusBadRequest, "invalid_request")

	// Warm the verified-password cache with the old password first.
	e.basic("alice", "old").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.basic("alice", "old").do("PUT", "/api/v1/me/password", map[string]string{"old_password": "old", "new_password": "new"}).
		expect(http.StatusNoContent)

	b.do("GET", "/api/v1/me", nil).expect(http.StatusOK) // existing session survives
	e.basic("alice", "old").do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	e.basic("alice", "new").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.anon().do("PUT", "/api/v1/me/password", map[string]string{"old_password": "new", "new_password": "x"}).
		expectError(http.StatusUnauthorized, "unauthorized")

	// Only the successful change is recorded, with the user as the actor.
	ev, err := e.store.ListAudit(t.Context(), store.AuditFilter{Action: "user.update", Limit: 10})
	if err != nil || len(ev) != 1 || ev[0].Actor == nil || ev[0].Actor.ID != alice.ID || ev[0].Subject.ID != alice.ID ||
		ev[0].Via != "basic" || string(ev[0].Detail) != `{"changes":{"password":true}}` {
		t.Fatalf("events = %+v, %v", ev, err)
	}
}

// User objects outside /admin/* carry the sharing statistics and status but
// not the administrators' note.
func TestUserViewsHideNote(t *testing.T) {
	e := newEnv(t, func(o *api.Options) { o.AllowRegister = true })
	alice := e.createUser("alice", "pw", false)
	if _, err := e.store.UpdateUser(t.Context(), store.SystemActor, alice.ID, store.UserUpdate{Note: new("secret note")}, e.clock()); err != nil {
		t.Fatal(err)
	}
	for name, r := range map[string]*response{
		"me":       e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK),
		"login":    e.anon().do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK),
		"register": e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": "bob", "password": "pw"}).expect(http.StatusCreated),
	} {
		var body struct {
			User map[string]any `json:"user"`
		}
		r.decode(&body)
		if _, ok := body.User["note"]; ok {
			t.Errorf("%s: user has a note: %s", name, r.body)
		}
		for _, key := range []string{"id", "username", "is_admin", "disabled", "created_at", "credential_count", "shared_in_count", "shared_out_count", "last_used_at"} {
			if _, ok := body.User[key]; !ok {
				t.Errorf("%s: user lacks %q: %s", name, key, r.body)
			}
		}
	}
	// Self-registration is recorded as done by the system.
	ev, _ := e.store.ListAudit(t.Context(), store.AuditFilter{Action: "user.create", Limit: 1})
	if len(ev) != 1 || ev[0].Subject.Username != "bob" || ev[0].Actor != nil || ev[0].Via != "system" {
		t.Fatalf("events = %+v", ev)
	}
}
