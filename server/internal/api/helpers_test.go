package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/riba2534/passkey-box/server/internal/api"
	"github.com/riba2534/passkey-box/server/internal/store"
	"github.com/riba2534/passkey-box/server/internal/web"
)

var startTime = time.Date(2026, 11, 20, 3, 30, 0, 0, time.UTC)

type env struct {
	t     *testing.T
	srv   *httptest.Server
	store *store.Store

	mu  sync.Mutex
	now time.Time
}

func newEnv(t *testing.T, configure ...func(*api.Options)) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "data", "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	st.PasswordCost = bcrypt.MinCost
	t.Cleanup(func() { st.Close() })

	e := &env{t: t, store: st, now: startTime}
	opts := api.Options{
		Store:   st,
		Version: "test-version",
		Web:     web.Handler(),
		Now:     e.clock,
	}
	for _, c := range configure {
		c(&opts)
	}
	e.srv = httptest.NewServer(api.New(opts))
	t.Cleanup(e.srv.Close)
	return e
}

func (e *env) clock() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now
}

func (e *env) advance(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.now = e.now.Add(d)
}

func (e *env) createUser(username, password string, isAdmin bool) store.User {
	e.t.Helper()
	u, err := e.store.CreateUser(context.Background(), username, password, isAdmin, e.clock())
	if err != nil {
		e.t.Fatalf("create user %s: %v", username, err)
	}
	return u
}

// client issues requests either with HTTP Basic credentials or with a cookie jar.
type client struct {
	e          *env
	user, pass string
	basic      bool
	http       *http.Client
}

func (e *env) basic(user, pass string) *client {
	return &client{e: e, user: user, pass: pass, basic: true, http: &http.Client{}}
}

func (e *env) anon() *client { return &client{e: e, http: &http.Client{}} }

func (e *env) browser() *client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return &client{e: e, http: &http.Client{Jar: jar}}
}

type response struct {
	t      *testing.T
	status int
	header http.Header
	body   []byte
}

func (c *client) do(method, path string, body any) *response {
	c.e.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = bytes.NewBufferString(b)
	default:
		data, err := json.Marshal(b)
		if err != nil {
			c.e.t.Fatal(err)
		}
		r = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.e.srv.URL+path, r)
	if err != nil {
		c.e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.basic {
		req.SetBasicAuth(c.user, c.pass)
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		c.e.t.Fatal(err)
	}
	return &response{t: c.e.t, status: res.StatusCode, header: res.Header, body: data}
}

func (r *response) expect(status int) *response {
	r.t.Helper()
	if r.status != status {
		r.t.Fatalf("status = %d, want %d; body: %s", r.status, status, r.body)
	}
	return r
}

// expectError checks the status and the documented error body.
func (r *response) expectError(status int, code string) {
	r.t.Helper()
	r.expect(status)
	if ct := r.header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		r.t.Errorf("Content-Type = %q", ct)
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	r.decode(&body)
	if body.Error.Code != code || body.Error.Message == "" {
		r.t.Fatalf("error = %+v, want code %q with a message", body.Error, code)
	}
}

func (r *response) decode(v any) {
	r.t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		r.t.Fatalf("decode %s: %v", r.body, err)
	}
}

type userJSON struct {
	ID              int64   `json:"id"`
	Username        string  `json:"username"`
	IsAdmin         bool    `json:"is_admin"`
	CreatedAt       string  `json:"created_at"`
	CredentialCount int     `json:"credential_count"`
	LastUsedAt      *string `json:"last_used_at"`
}

type credJSON struct {
	ID              string  `json:"id"`
	RPID            string  `json:"rp_id"`
	RPName          string  `json:"rp_name"`
	UserHandle      string  `json:"user_handle"`
	UserName        string  `json:"user_name"`
	UserDisplayName string  `json:"user_display_name"`
	Alg             int     `json:"alg"`
	PrivateKey      string  `json:"private_key"`
	PublicKey       string  `json:"public_key"`
	SignCount       int64   `json:"sign_count"`
	Label           string  `json:"label"`
	Origin          string  `json:"origin"`
	CreatedAt       string  `json:"created_at"`
	LastUsedAt      *string `json:"last_used_at"`
	UseCount        int64   `json:"use_count"`
}

func (r *response) user() userJSON {
	r.t.Helper()
	var body struct {
		User *userJSON `json:"user"`
	}
	r.decode(&body)
	if body.User == nil {
		r.t.Fatalf("no user in %s", r.body)
	}
	return *body.User
}

func (r *response) users() []userJSON {
	r.t.Helper()
	var body struct {
		Users []userJSON `json:"users"`
	}
	r.decode(&body)
	if body.Users == nil {
		r.t.Fatalf("users missing or null in %s", r.body)
	}
	return body.Users
}

func (r *response) credential() credJSON {
	r.t.Helper()
	var body struct {
		Credential *credJSON `json:"credential"`
	}
	r.decode(&body)
	if body.Credential == nil {
		r.t.Fatalf("no credential in %s", r.body)
	}
	return *body.Credential
}

func (r *response) credentials() []credJSON {
	r.t.Helper()
	var body struct {
		Credentials []credJSON `json:"credentials"`
	}
	r.decode(&body)
	if body.Credentials == nil {
		r.t.Fatalf("credentials missing or null in %s", r.body)
	}
	return body.Credentials
}

func credIDs(creds []credJSON) []string {
	ids := make([]string, 0, len(creds))
	for _, c := range creds {
		ids = append(ids, c.ID)
	}
	return ids
}

// newCred returns a valid POST /api/v1/credentials body.
func newCred(id, rpID, userHandle string) map[string]any {
	return map[string]any{
		"id":                id,
		"rp_id":             rpID,
		"rp_name":           "Example",
		"user_handle":       userHandle,
		"user_name":         "alice@example.com",
		"user_display_name": "Alice",
		"alg":               -7,
		"private_key":       "cHJpdmF0ZS1rZXk",
		"public_key":        "cHVibGljLWtleQ",
		"origin":            "https://" + rpID,
		"label":             "",
	}
}

func sessionCookieFrom(r *response) *http.Cookie {
	for _, c := range (&http.Response{Header: r.header}).Cookies() {
		if c.Name == "pkb_session" {
			return c
		}
	}
	return nil
}
