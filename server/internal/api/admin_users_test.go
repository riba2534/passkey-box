package api_test

import (
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type adminUserJSON struct {
	userJSON
	Disabled       bool   `json:"disabled"`
	SharedInCount  int    `json:"shared_in_count"`
	SharedOutCount int    `json:"shared_out_count"`
	Note           string `json:"note"`
}

func (r *response) adminUser() adminUserJSON {
	r.t.Helper()
	var body struct {
		User *adminUserJSON `json:"user"`
	}
	r.decode(&body)
	if body.User == nil {
		r.t.Fatalf("no user in %s", r.body)
	}
	return *body.User
}

func (r *response) adminUsers() []adminUserJSON {
	r.t.Helper()
	var body struct {
		Users []adminUserJSON `json:"users"`
	}
	r.decode(&body)
	if body.Users == nil {
		r.t.Fatalf("users missing or null in %s", r.body)
	}
	return body.Users
}

func usernames(users []adminUserJSON) []string {
	out := []string{}
	for _, u := range users {
		out = append(out, u.Username)
	}
	return out
}

func TestAdminGetAndUpdateUser(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	e.createUser("bob", "pw", false)
	admin := e.basic("root", "pw")
	path := fmt.Sprintf("/api/v1/admin/users/%d", alice.ID)

	r := admin.do("GET", path, nil).expect(http.StatusOK)
	if u := r.adminUser(); u.ID != alice.ID || u.Username != "alice" || u.Note != "" || u.Disabled || !strings.Contains(string(r.body), `"note":""`) {
		t.Fatalf("user = %s", r.body)
	}
	admin.do("GET", "/api/v1/admin/users/999", nil).expectError(http.StatusNotFound, "not_found")

	// Renaming retires the old name for HTTP Basic, also after a cached sign-in.
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	u := admin.do("PATCH", path, map[string]any{"username": " Alicia ", "note": "运营"}).expect(http.StatusOK).adminUser()
	if u.Username != "Alicia" || u.Note != "运营" {
		t.Fatalf("patched = %+v", u)
	}
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	e.basic("alicia", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	admin.do("PATCH", path, map[string]any{"username": "BOB"}).expectError(http.StatusConflict, "conflict")
	admin.do("PATCH", path, map[string]any{"username": " "}).expectError(http.StatusBadRequest, "invalid_request")
	ev := e.events(store.AuditFilter{Action: "user.update", Limit: 1})
	if len(ev) != 1 || ev[0].Actor.ID != root.ID || ev[0].Via != "basic" || ev[0].Subject.Username != "alice" ||
		string(ev[0].Detail) != `{"changes":{"note":{"from":"","to":"运营"},"username":{"from":"alice","to":"Alicia"}}}` {
		t.Fatalf("event = %+v %s", ev, ev[0].Detail)
	}

	// A disabled user cannot use any sign-in method.
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alicia", "password": "pw"}).expect(http.StatusOK)
	token := e.createToken(alice.ID, "agent", false, nil)
	if u := admin.do("PATCH", path, map[string]any{"disabled": true}).expect(http.StatusOK).adminUser(); !u.Disabled {
		t.Fatalf("not disabled: %+v", u)
	}
	e.basic("alicia", "pw").do("GET", "/api/v1/me", nil).expectError(http.StatusForbidden, "account_disabled")
	e.bearer(token).do("GET", "/api/v1/me", nil).expectError(http.StatusForbidden, "account_disabled")
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusForbidden, "account_disabled")
	e.anon().do("POST", "/api/v1/auth/login", map[string]string{"username": "alicia", "password": "pw"}).expectError(http.StatusForbidden, "account_disabled")
	admin.do("PATCH", path, map[string]any{"disabled": false}).expect(http.StatusOK)
	e.basic("alicia", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)

	// Administrators cannot lock themselves out.
	self := fmt.Sprintf("/api/v1/admin/users/%d", root.ID)
	admin.do("PATCH", self, map[string]any{"disabled": true}).expectError(http.StatusBadRequest, "invalid_request")
	admin.do("PATCH", self, map[string]any{"disabled": true, "note": "x"}).expectError(http.StatusBadRequest, "invalid_request")
	if u := admin.do("GET", self, nil).expect(http.StatusOK).adminUser(); u.Disabled || u.Note != "" || !u.IsAdmin {
		t.Fatalf("root = %+v", u)
	}
}

func TestAdminCreateAndDeleteUserAreAudited(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	admin := e.bearer(e.createToken(root.ID, "ops", false, nil))

	u := admin.do("POST", "/api/v1/admin/users", map[string]any{"username": "dave", "password": "pw", "note": "新人"}).expect(http.StatusCreated).adminUser()
	if u.Note != "新人" || u.IsAdmin {
		t.Fatalf("created = %+v", u)
	}
	e.basic("dave", "pw").do("POST", "/api/v1/credentials", newCred("ZGF2ZQ", "a.com", "ZA")).expect(http.StatusCreated)
	admin.do("DELETE", fmt.Sprintf("/api/v1/admin/users/%d", u.ID), nil).expect(http.StatusNoContent)
	admin.do("DELETE", fmt.Sprintf("/api/v1/admin/users/%d", u.ID), nil).expectError(http.StatusNotFound, "not_found")

	ev := e.events(store.AuditFilter{ActorID: root.ID, Action: "user."})
	if len(ev) != 2 || ev[0].Action != "user.delete" || ev[1].Action != "user.create" {
		t.Fatalf("events = %+v", ev)
	}
	for _, x := range ev {
		if x.Via != "token:ops" || x.Subject.ID != u.ID || x.Subject.Username != "dave" || x.Target != nil {
			t.Fatalf("event = %+v", x)
		}
	}
	if string(ev[0].Detail) != `{"credentials_deleted":1,"credentials_transferred":0}` || string(ev[1].Detail) != `{"is_admin":false}` {
		t.Fatalf("details = %s, %s", ev[0].Detail, ev[1].Detail)
	}
}

func TestAdminRevokeSessions(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	admin := e.basic("root", "pw")
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)
	token := e.createToken(alice.ID, "agent", false, nil)

	var got map[string]int
	admin.do("POST", fmt.Sprintf("/api/v1/admin/users/%d/revoke-sessions", alice.ID), nil).expect(http.StatusOK).decode(&got)
	if !reflect.DeepEqual(got, map[string]int{"sessions": 1, "tokens": 1}) {
		t.Fatalf("revoked = %v", got)
	}
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	e.bearer(token).do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	if ev := e.events(store.AuditFilter{Action: "user.revoke_sessions"}); len(ev) != 1 || ev[0].Subject.ID != alice.ID || ev[0].Via != "basic" {
		t.Fatalf("events = %+v", ev)
	}
}

func TestAdminListUsersFilters(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	bob := e.createUser("Bob", "pw", true)
	carol := e.createUser("carol", "pw", false)
	admin := e.basic("root", "pw")
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", alice.ID), map[string]any{"note": "Team A"}).expect(http.StatusOK)
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", carol.ID), map[string]any{"disabled": true}).expect(http.StatusOK)

	for query, want := range map[string][]string{
		"":                         {"root", "alice", "Bob", "carol"},
		"?q=TEAM":                  {"alice"},
		"?q=b":                     {"Bob"},
		"?role=admin":              {"root", "Bob"},
		"?role=user&status=active": {"alice"},
		"?status=disabled":         {"carol"},
		"?q=nobody":                {},
	} {
		users := admin.do("GET", "/api/v1/admin/users"+query, nil).expect(http.StatusOK).adminUsers()
		if got := usernames(users); !slices.Equal(got, want) {
			t.Errorf("%q: got %v, want %v", query, got, want)
		}
	}
	users := admin.do("GET", "/api/v1/admin/users?q=team", nil).adminUsers()
	if users[0].Note != "Team A" || users[0].ID != alice.ID {
		t.Fatalf("alice = %+v", users[0])
	}
	if users := admin.do("GET", "/api/v1/admin/users?role=admin", nil).adminUsers(); users[1].ID != bob.ID || !users[1].IsAdmin {
		t.Fatalf("bob = %+v", users[1])
	}
	admin.do("GET", "/api/v1/admin/users?role=owner", nil).expectError(http.StatusBadRequest, "invalid_request")
	admin.do("GET", "/api/v1/admin/users?status=gone", nil).expectError(http.StatusBadRequest, "invalid_request")
}

type batchUsersJSON struct {
	DryRun  bool `json:"dry_run"`
	Results []struct {
		User     adminUserJSON `json:"user"`
		Changes  []string      `json:"changes"`
		Password *string       `json:"password"`
	} `json:"results"`
}

var generatedPassword = regexp.MustCompile(`^[A-Za-z0-9]{16}$`)

func TestAdminBatchCreateUsers(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	e.createUser("taken", "pw", false)
	admin := e.basic("root", "pw")
	const path = "/api/v1/admin/users/batch-create"
	before := len(e.events(store.AuditFilter{}))

	many := make([]map[string]any, 201)
	for i := range many {
		many[i] = map[string]any{"username": fmt.Sprintf("u%d", i)}
	}
	for _, body := range []any{
		"nope",
		map[string]any{"users": []any{}},
		map[string]any{"users": []any{map[string]any{"password": "x"}}},
		map[string]any{"users": many},
	} {
		admin.do("POST", path, body).expectPlainError()
	}

	long := strings.Repeat("n", 65)
	admin.do("POST", path, map[string]any{"users": []any{
		map[string]any{"username": "alice"},
		map[string]any{"username": "TAKEN"},
		map[string]any{"username": "Alice"},
		map[string]any{"username": "eve", "password": ""},
		map[string]any{"username": long, "password": "x"},
	}}).expectItems(
		item{"users", 1, "TAKEN", "conflict", "username already exists"},
		item{"users", 2, "Alice", "conflict", "username already exists"},
		item{"users", 3, "eve", "invalid_request", "password must not be empty"},
		item{"users", 4, long, "invalid_request", "username must be 1-64 characters"},
	)

	users := []any{
		map[string]any{"username": "alice"},
		map[string]any{"username": "bob", "password": "bob-pw", "is_admin": true, "note": "ops"},
		map[string]any{"username": "carol"},
	}
	var dry batchUsersJSON
	admin.do("POST", path, map[string]any{"users": users, "dry_run": true}).expect(http.StatusOK).decode(&dry)
	if !dry.DryRun || len(dry.Results) != 3 || dry.Results[0].User.Username != "alice" || dry.Results[0].User.ID == 0 ||
		!dry.Results[1].User.IsAdmin || dry.Results[1].User.Note != "ops" {
		t.Fatalf("dry run = %+v", dry)
	}
	for _, res := range dry.Results {
		if res.Password != nil {
			t.Fatalf("dry run revealed a password: %+v", res)
		}
	}
	if n := len(admin.do("GET", "/api/v1/admin/users", nil).adminUsers()); n != 2 {
		t.Fatalf("failed and dry-run batches left %d users", n)
	}
	if n := len(e.events(store.AuditFilter{})); n != before {
		t.Fatalf("failed and dry-run batches recorded %d events", n-before)
	}

	var res batchUsersJSON
	admin.do("POST", path, map[string]any{"users": users}).expect(http.StatusOK).decode(&res)
	if res.DryRun || len(res.Results) != 3 || res.Results[1].Password != nil {
		t.Fatalf("result = %+v", res)
	}
	alicePW, carolPW := res.Results[0].Password, res.Results[2].Password
	if alicePW == nil || carolPW == nil || !generatedPassword.MatchString(*alicePW) || !generatedPassword.MatchString(*carolPW) || *alicePW == *carolPW {
		t.Fatalf("generated passwords = %v, %v", alicePW, carolPW)
	}
	e.basic("alice", *alicePW).do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.basic("carol", *carolPW).do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	if u := e.basic("bob", "bob-pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK).user(); !u.IsAdmin {
		t.Fatalf("bob = %+v", u)
	}
	ev := e.events(store.AuditFilter{Action: "user.create", ActorID: root.ID})
	if len(ev) != 3 || ev[0].Subject.Username != "carol" || ev[0].Via != "basic" {
		t.Fatalf("events = %+v", ev)
	}
}

func TestAdminBatchUpdateUsers(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	e.createUser("bob", "pw", false)
	e.createUser("carol", "pw", false)
	admin := e.basic("root", "pw")
	const path = "/api/v1/admin/users/batch-update"
	before := len(e.events(store.AuditFilter{}))

	many := make([]map[string]any, 1001)
	for i := range many {
		many[i] = map[string]any{"user": i + 1, "note": "x"}
	}
	for _, body := range []any{
		map[string]any{"items": []any{}},
		map[string]any{"items": []any{map[string]any{"note": "x"}}},
		map[string]any{"items": []any{map[string]any{"user": true, "note": "x"}}},
		map[string]any{"items": []any{map[string]any{"user": "alice", "password": "x", "generate_password": true}}},
		map[string]any{"items": many},
	} {
		admin.do("POST", path, body).expectPlainError()
	}

	admin.do("POST", path, map[string]any{"items": []any{
		map[string]any{"user": "alice", "note": "n"},
		map[string]any{"user": alice.ID, "disabled": true},
		map[string]any{"user": "ghost", "note": "n"},
		map[string]any{"user": root.ID, "is_admin": false},
		map[string]any{"user": "bob", "username": "Carol"},
		map[string]any{"user": "carol", "password": ""},
	}}).expectItems(
		item{"items", 1, float64(alice.ID), "invalid_request", "duplicate item"},
		item{"items", 2, "ghost", "not_found", "user not found"},
		item{"items", 3, float64(root.ID), "invalid_request", "you cannot remove your own administrator role"},
		item{"items", 4, "bob", "conflict", "username already exists"},
		item{"items", 5, "carol", "invalid_request", "password must not be empty"},
	)

	items := []any{
		map[string]any{"user": "alice", "generate_password": true, "note": "n"},
		map[string]any{"user": "bob", "disabled": true, "is_admin": false},
	}
	var dry batchUsersJSON
	admin.do("POST", path, map[string]any{"items": items, "dry_run": true}).expect(http.StatusOK).decode(&dry)
	if !dry.DryRun || len(dry.Results) != 2 || !slices.Equal(dry.Results[0].Changes, []string{"password", "note"}) ||
		!slices.Equal(dry.Results[1].Changes, []string{"disabled"}) || dry.Results[0].Password != nil || !dry.Results[1].User.Disabled {
		t.Fatalf("dry run = %+v", dry)
	}
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.basic("bob", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	if n := len(e.events(store.AuditFilter{})); n != before {
		t.Fatalf("failed and dry-run batches recorded %d events", n-before)
	}

	var res batchUsersJSON
	admin.do("POST", path, map[string]any{"items": items}).expect(http.StatusOK).decode(&res)
	if res.DryRun || res.Results[0].User.Note != "n" || res.Results[1].Password != nil || res.Results[0].Password == nil ||
		!generatedPassword.MatchString(*res.Results[0].Password) {
		t.Fatalf("result = %+v", res)
	}
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	e.basic("alice", *res.Results[0].Password).do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.basic("bob", "pw").do("GET", "/api/v1/me", nil).expectError(http.StatusForbidden, "account_disabled")
	if ev := e.events(store.AuditFilter{Action: "user.update", ActorID: root.ID}); len(ev) != 2 ||
		string(ev[1].Detail) != `{"changes":{"note":{"from":"","to":"n"},"password":true}}` {
		t.Fatalf("events = %+v", ev)
	}
}

func TestAdminBatchDeleteUsers(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	bob := e.createUser("bob", "pw", false)
	carol := e.createUser("carol", "pw", false)
	e.basic("alice", "pw").do("POST", "/api/v1/credentials", newCred("YWxpY2Ux", "github.com", "MQ")).expect(http.StatusCreated)
	e.basic("alice", "pw").do("POST", "/api/v1/credentials", newCred("YWxpY2Uy", "gitlab.com", "Mg")).expect(http.StatusCreated)
	e.basic("bob", "pw").do("POST", "/api/v1/credentials", newCred("Ym9i", "github.com", "Mw")).expect(http.StatusCreated)
	admin := e.basic("root", "pw")
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", carol.ID), map[string]any{"disabled": true}).expect(http.StatusOK)
	const path = "/api/v1/admin/users/batch-delete"
	before := len(e.events(store.AuditFilter{}))

	many := make([]int, 101)
	for i := range many {
		many[i] = i + 1
	}
	for _, body := range []any{
		map[string]any{"users": []any{}},
		map[string]any{"users": []any{true}},
		map[string]any{"users": []any{"alice"}, "transfer_credentials_to": 0},
		map[string]any{"users": many},
	} {
		admin.do("POST", path, body).expectPlainError()
	}
	admin.do("POST", path, map[string]any{"users": []any{"alice", alice.ID, "ghost", root.ID}, "transfer_credentials_to": "carol"}).expectItems(
		item{"users", 1, float64(alice.ID), "invalid_request", "duplicate item"},
		item{"users", 2, "ghost", "not_found", "user not found"},
		item{"users", 3, float64(root.ID), "invalid_request", "you cannot delete yourself"},
		item{"transfer_credentials_to", 0, "carol", "invalid_request", "user is disabled"},
	)
	admin.do("POST", path, map[string]any{"users": []any{"alice"}, "transfer_credentials_to": "ALICE"}).expectItems(
		item{"transfer_credentials_to", 0, "ALICE", "invalid_request", "the recipient is being deleted"},
	)

	type result struct {
		User                   map[string]any `json:"user"`
		CredentialsDeleted     int            `json:"credentials_deleted"`
		CredentialsTransferred int            `json:"credentials_transferred"`
	}
	var dry, res struct {
		DryRun  bool     `json:"dry_run"`
		Results []result `json:"results"`
	}
	want := []result{{User: map[string]any{"id": float64(alice.ID), "username": "alice"}, CredentialsTransferred: 2}}
	body := map[string]any{"users": []any{"alice"}, "transfer_credentials_to": bob.ID, "dry_run": true}
	admin.do("POST", path, body).expect(http.StatusOK).decode(&dry)
	if !dry.DryRun || !reflect.DeepEqual(dry.Results, want) {
		t.Fatalf("dry run = %+v", dry)
	}
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	if n := len(e.events(store.AuditFilter{})); n != before {
		t.Fatalf("failed and dry-run batches recorded %d events", n-before)
	}

	body["dry_run"] = false
	admin.do("POST", path, body).expect(http.StatusOK).decode(&res)
	if res.DryRun || !reflect.DeepEqual(res.Results, want) {
		t.Fatalf("result = %+v", res)
	}
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	got := credIDs(e.basic("bob", "pw").do("GET", "/api/v1/credentials", nil).expect(http.StatusOK).credentials())
	slices.Sort(got)
	if !slices.Equal(got, []string{"YWxpY2Ux", "YWxpY2Uy", "Ym9i"}) {
		t.Fatalf("bob's credentials = %v", got)
	}
	ev := e.events(store.AuditFilter{ActorID: root.ID, Action: "credential.transfer"})
	if len(ev) != 2 || ev[0].Subject.ID != alice.ID || ev[0].Target.ID != bob.ID || ev[0].Credential == nil ||
		ev[0].Credential.ID != "YWxpY2Uy" || string(ev[0].Detail) != `{"keep_access":false}` {
		t.Fatalf("transfer events = %+v", ev)
	}
	if ev := e.events(store.AuditFilter{Action: "user.delete"}); len(ev) != 1 || ev[0].Target.Username != "bob" ||
		string(ev[0].Detail) != `{"credentials_deleted":0,"credentials_transferred":2}` {
		t.Fatalf("delete events = %+v", ev)
	}

	// Without a recipient the credentials are deleted with the user.
	admin.do("POST", path, map[string]any{"users": []any{"bob"}}).expect(http.StatusOK).decode(&res)
	if len(res.Results) != 1 || res.Results[0].CredentialsDeleted != 3 || res.Results[0].CredentialsTransferred != 0 {
		t.Fatalf("result = %+v", res)
	}
}
