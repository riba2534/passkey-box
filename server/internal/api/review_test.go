package api_test

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/riba2534/passkey-box/server/internal/api"
)

// An API token must not renew itself by changing its own user's password,
// through /me/password (sessionOnly) or the administrator endpoints.
func TestTokenCannotChangeItsOwnPasswordAsAdmin(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	bob := e.createUser("bob", "pw", false)
	c := e.bearer(e.createToken(root.ID, "ops", false, nil))
	self := fmt.Sprintf("/api/v1/admin/users/%d", root.ID)

	c.do("PATCH", self, map[string]any{"password": "new"}).expectError(http.StatusBadRequest, "invalid_request")
	if got := c.do("POST", "/api/v1/admin/users/batch-update", map[string]any{
		"items": []any{map[string]any{"user": "root", "password": "new"}}}).items(); !slices.Equal(got, []string{"items[0]=root:invalid_request"}) {
		t.Fatalf("items = %v", got)
	}
	if got := c.do("POST", "/api/v1/admin/users/batch-update", map[string]any{
		"items": []any{map[string]any{"user": root.ID, "generate_password": true}}, "dry_run": true}).items(); len(got) != 1 {
		t.Fatalf("items = %v", got)
	}
	e.basic("root", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)

	// Other fields of its own user, and other users' passwords, stay allowed:
	// an administrator's token can do what the administrator can.
	c.do("PATCH", self, map[string]any{"note": "ops"}).expect(http.StatusOK)
	c.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", bob.ID), map[string]any{"password": "bob2"}).expect(http.StatusOK)
	e.basic("bob", "bob2").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	// With a password or a session the administrator can change their own.
	e.basic("root", "pw").do("PATCH", self, map[string]any{"password": "pw2"}).expect(http.StatusOK)
	e.basic("root", "pw2").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
}

func TestPasswordsLongerThanBcryptAllowsAreInvalid(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	admin := e.basic("root", "pw")
	long := strings.Repeat("p", 73)
	admin.do("POST", "/api/v1/admin/users", map[string]any{"username": "u", "password": long}).expectError(http.StatusBadRequest, "invalid_request")
	// The dry run already reports it, per entry, though it skips hashing.
	if got := admin.do("POST", "/api/v1/admin/users/batch-create", map[string]any{
		"users":   []any{map[string]any{"username": "ok", "password": strings.Repeat("p", 72)}, map[string]any{"username": "long", "password": long}},
		"dry_run": true}).items(); !slices.Equal(got, []string{"users[1]=long:invalid_request"}) {
		t.Fatalf("items = %v", got)
	}
	admin.do("PUT", "/api/v1/me/password", map[string]any{"old_password": "pw", "new_password": long}).expectError(http.StatusBadRequest, "invalid_request")
	e.basic("root", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
}

// The note is the administrators' note about a user; the user's own activity
// says that it changed but not what it says.
func TestActivityHidesAdministratorNotesFromTheUser(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	bob := e.createUser("bob", "pw", false)
	admin := e.basic("root", "pw")
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", bob.ID), map[string]any{"note": "leaving next month", "disabled": false, "is_admin": false}).expect(http.StatusOK)
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", bob.ID), map[string]any{"username": "bobby"}).expect(http.StatusOK)

	body := func(c *client, path string) string {
		return string(c.do("GET", path, nil).expect(http.StatusOK).body)
	}
	mine := body(e.basic("bobby", "pw"), "/api/v1/me/activity")
	if strings.Contains(mine, "leaving") || !strings.Contains(mine, `"note":true`) || !strings.Contains(mine, `"to":"bobby"`) {
		t.Fatalf("bob's activity = %s", mine)
	}
	for _, path := range []string{"/api/v1/admin/audit", "/api/v1/me/activity", "/api/v1/admin/overview"} {
		if got := body(admin, path); !strings.Contains(got, `"to":"leaving next month"`) {
			t.Errorf("administrator's %s lacks the note: %s", path, got)
		}
	}
}

func TestRegistrationCannotTakeTheBootstrapAdminName(t *testing.T) {
	e := newEnv(t, func(o *api.Options) { o.AllowRegister = true })
	if _, err := e.store.EnsureAdmin(t.Context(), "admin", "pw", e.clock()); err != nil {
		t.Fatal(err)
	}
	// Another administrator deletes the bootstrap account; until the next
	// start recreates it, nobody may register the name and be promoted.
	root := e.createUser("root", "pw", true)
	admin := e.basic("root", "pw")
	users := admin.do("GET", "/api/v1/admin/users?q=admin", nil).expect(http.StatusOK).users()
	if len(users) != 1 || users[0].ID == root.ID {
		t.Fatalf("users = %+v", users)
	}
	admin.do("DELETE", fmt.Sprintf("/api/v1/admin/users/%d", users[0].ID), nil).expect(http.StatusNoContent)
	e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": "Admin", "password": "x"}).expectError(http.StatusConflict, "conflict")
	e.anon().do("POST", "/api/v1/auth/register", map[string]string{"username": "eve", "password": "x"}).expect(http.StatusCreated)
}

// raw sends a request with extra headers through c's HTTP client (and so its
// cookie jar), without c's own credentials.
func (c *client) raw(method, path string, headers map[string]string) int {
	c.e.t.Helper()
	req, err := http.NewRequest(method, c.e.srv.URL+path, strings.NewReader(`{"label":"x"}`))
	if err != nil {
		c.e.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestMalformedAuthorizationIsNotRetriedWithTheCookie(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)
	for _, h := range []string{"Basic", "Basic !!!", "basic\tYWxpY2U6cHc", "Bearer", "Bearer   ", "bearer\tpkb_x", "BEARER pkb_x"} {
		if got := b.raw("GET", "/api/v1/me", map[string]string{"Authorization": h}); got != http.StatusUnauthorized {
			t.Errorf("Authorization %q = %d, want 401", h, got)
		}
	}
	// Other schemes are not ours: the cookie still counts.
	if got := b.raw("GET", "/api/v1/me", map[string]string{"Authorization": "Digest x"}); got != http.StatusOK {
		t.Errorf("Digest = %d", got)
	}
}

func TestSessionsRefuseCrossSiteWrites(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	e.basic("alice", "pw").do("POST", "/api/v1/credentials", newCred("YQ", "a.com", "YQ")).expect(http.StatusCreated)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)
	host := strings.TrimPrefix(e.srv.URL, "http://")

	for _, tc := range []struct {
		method  string
		headers map[string]string
		want    int
	}{
		{"PATCH", map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{"PATCH", map[string]string{"Sec-Fetch-Site": "same-site"}, http.StatusForbidden},
		{"PATCH", map[string]string{"Origin": "https://tu.example.com"}, http.StatusForbidden},
		{"PATCH", map[string]string{"Sec-Fetch-Site": "same-origin"}, http.StatusOK},
		{"PATCH", map[string]string{"Origin": "http://" + host}, http.StatusOK},
		{"PATCH", nil, http.StatusOK}, // not a browser
		{"GET", map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusOK},
	} {
		if got := b.raw(tc.method, "/api/v1/credentials/YQ", tc.headers); got != tc.want {
			t.Errorf("%s %v = %d, want %d", tc.method, tc.headers, got, tc.want)
		}
	}
	// HTTP Basic is not a cookie a browser attaches by itself.
	basic := e.basic("alice", "pw")
	req, _ := http.NewRequest("PATCH", e.srv.URL+"/api/v1/credentials/YQ", strings.NewReader(`{"label":"y"}`))
	req.SetBasicAuth("alice", "pw")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	res, err := basic.http.Do(req)
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("basic cross-site = %v %v", res, err)
	}
	res.Body.Close()
}
