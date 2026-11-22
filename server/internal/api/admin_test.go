package api_test

import (
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"
)

func TestAdminEndpointsRequireAdmin(t *testing.T) {
	e := newEnv(t)
	e.createUser("admin", "pw", true)
	alice := e.createUser("alice", "pw", false)
	e.basic("alice", "pw").do("POST", "/api/v1/credentials", newCred("YQ", "a.com", "YQ")).expect(http.StatusCreated)

	endpoints := []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/v1/admin/users", nil},
		{"POST", "/api/v1/admin/users", map[string]any{"username": "eve", "password": "pw"}},
		{"PATCH", fmt.Sprintf("/api/v1/admin/users/%d", alice.ID), map[string]any{"is_admin": true}},
		{"DELETE", fmt.Sprintf("/api/v1/admin/users/%d", alice.ID), nil},
		{"GET", fmt.Sprintf("/api/v1/admin/users/%d/credentials", alice.ID), nil},
		{"DELETE", fmt.Sprintf("/api/v1/admin/users/%d/credentials/YQ", alice.ID), nil},
		{"GET", fmt.Sprintf("/api/v1/admin/users/%d", alice.ID), nil},
		{"POST", fmt.Sprintf("/api/v1/admin/users/%d/revoke-sessions", alice.ID), nil},
		{"POST", "/api/v1/admin/users/batch-create", map[string]any{"users": []any{map[string]any{"username": "eve", "password": "pw"}}}},
		{"POST", "/api/v1/admin/users/batch-update", map[string]any{"items": []any{map[string]any{"user": "alice", "is_admin": true}}}},
		{"POST", "/api/v1/admin/users/batch-delete", map[string]any{"users": []any{"alice"}}},
		{"GET", "/api/v1/admin/overview", nil},
		{"GET", "/api/v1/admin/audit", nil},
		{"GET", "/api/v1/admin/unknown", nil},
	}
	for _, ep := range endpoints {
		t.Run(ep.method+" "+ep.path, func(t *testing.T) {
			e.basic("alice", "pw").do(ep.method, ep.path, ep.body).expectError(http.StatusForbidden, "forbidden")
			e.anon().do(ep.method, ep.path, ep.body).expectError(http.StatusUnauthorized, "unauthorized")
		})
	}

	// Nothing changed.
	me := e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK).user()
	if me.IsAdmin || me.CredentialCount != 1 {
		t.Fatalf("alice = %+v", me)
	}
	e.basic("eve", "pw").do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestAdminUserManagement(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	admin := e.basic("root", "pw")

	e.advance(time.Minute)
	bob := admin.do("POST", "/api/v1/admin/users", map[string]any{"username": " Bob ", "password": "bob-pw"}).expect(http.StatusCreated).user()
	if bob.Username != "Bob" || bob.IsAdmin || bob.CreatedAt != "2026-11-20T03:31:00Z" || bob.CredentialCount != 0 {
		t.Fatalf("bob = %+v", bob)
	}
	carol := admin.do("POST", "/api/v1/admin/users", map[string]any{"username": "carol", "password": "c", "is_admin": true}).expect(http.StatusCreated).user()
	if !carol.IsAdmin {
		t.Fatalf("carol = %+v", carol)
	}
	admin.do("POST", "/api/v1/admin/users", map[string]any{"username": "BOB", "password": "x"}).expectError(http.StatusConflict, "conflict")
	admin.do("POST", "/api/v1/admin/users", map[string]any{"username": "", "password": "x"}).expectError(http.StatusBadRequest, "invalid_request")
	admin.do("POST", "/api/v1/admin/users", map[string]any{"username": "dave"}).expectError(http.StatusBadRequest, "invalid_request")
	admin.do("POST", "/api/v1/admin/users", "nope").expectError(http.StatusBadRequest, "invalid_request")

	var ids []int64
	for _, u := range admin.do("GET", "/api/v1/admin/users", nil).expect(http.StatusOK).users() {
		ids = append(ids, u.ID)
	}
	if want := []int64{root.ID, bob.ID, carol.ID}; !slices.Equal(ids, want) {
		t.Fatalf("user ids = %v, want %v", ids, want)
	}

	bobPath := fmt.Sprintf("/api/v1/admin/users/%d", bob.ID)

	// Reset password: the old one stops working.
	e.basic("bob", "bob-pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	u := admin.do("PATCH", bobPath, map[string]any{"password": "reset"}).expect(http.StatusOK).user()
	if u.ID != bob.ID || u.IsAdmin {
		t.Fatalf("patched = %+v", u)
	}
	e.basic("bob", "bob-pw").do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	e.basic("bob", "reset").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	admin.do("PATCH", bobPath, map[string]any{"password": ""}).expectError(http.StatusBadRequest, "invalid_request")

	// Grant and revoke administrator rights.
	if u := admin.do("PATCH", bobPath, map[string]any{"is_admin": true}).expect(http.StatusOK).user(); !u.IsAdmin {
		t.Fatalf("bob not admin: %+v", u)
	}
	e.basic("bob", "reset").do("GET", "/api/v1/admin/users", nil).expect(http.StatusOK)
	if u := admin.do("PATCH", bobPath, map[string]any{"is_admin": false}).expect(http.StatusOK).user(); u.IsAdmin {
		t.Fatalf("bob still admin: %+v", u)
	}
	e.basic("bob", "reset").do("GET", "/api/v1/admin/users", nil).expectError(http.StatusForbidden, "forbidden")

	// Credentials of another user.
	bobClient := e.basic("bob", "reset")
	bobClient.do("POST", "/api/v1/credentials", newCred("Ym9iMQ", "github.com", "MQ")).expect(http.StatusCreated)
	bobClient.do("POST", "/api/v1/credentials", newCred("Ym9iMg", "gitlab.com", "Mg")).expect(http.StatusCreated)
	creds := admin.do("GET", bobPath+"/credentials", nil).expect(http.StatusOK).credentials()
	if got := credIDs(creds); !slices.Equal(got, []string{"Ym9iMg", "Ym9iMQ"}) {
		t.Fatalf("bob's credentials = %v", got)
	}
	if creds[0].PrivateKey == "" {
		t.Fatal("admin view should include the full credential")
	}
	if n := len(admin.do("GET", fmt.Sprintf("/api/v1/admin/users/%d/credentials", root.ID), nil).credentials()); n != 0 {
		t.Fatalf("root has %d credentials", n)
	}
	admin.do("DELETE", bobPath+"/credentials/Ym9iMQ", nil).expect(http.StatusNoContent)
	admin.do("DELETE", bobPath+"/credentials/Ym9iMQ", nil).expectError(http.StatusNotFound, "not_found")
	// A credential ID that only exists for bob is not found under carol.
	admin.do("DELETE", fmt.Sprintf("/api/v1/admin/users/%d/credentials/Ym9iMg", carol.ID), nil).expectError(http.StatusNotFound, "not_found")
	if got := credIDs(bobClient.do("GET", "/api/v1/credentials", nil).credentials()); !slices.Equal(got, []string{"Ym9iMg"}) {
		t.Fatalf("bob's credentials after admin delete = %v", got)
	}

	// Deleting a user removes its credentials and sessions.
	bobBrowser := e.browser()
	bobBrowser.do("POST", "/api/v1/auth/login", map[string]string{"username": "bob", "password": "reset"}).expect(http.StatusOK)
	admin.do("DELETE", bobPath, nil).expect(http.StatusNoContent)
	bobBrowser.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	bobClient.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
	admin.do("GET", bobPath+"/credentials", nil).expectError(http.StatusNotFound, "not_found")
	if creds, err := e.store.ListCredentials(t.Context(), bob.ID, ""); err != nil || len(creds) != 0 {
		t.Fatalf("bob's credentials after delete = %v, %v", creds, err)
	}
	// A new user with the same name starts empty.
	newBob := admin.do("POST", "/api/v1/admin/users", map[string]any{"username": "bob", "password": "x"}).expect(http.StatusCreated).user()
	if newBob.CredentialCount != 0 || newBob.ID == bob.ID {
		t.Fatalf("new bob = %+v", newBob)
	}
}

func TestAdminUnknownUser(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	admin := e.basic("root", "pw")
	for _, id := range []string{"999", "abc"} {
		p := "/api/v1/admin/users/" + id
		admin.do("GET", p, nil).expectError(http.StatusNotFound, "not_found")
		admin.do("PATCH", p, map[string]any{"is_admin": true}).expectError(http.StatusNotFound, "not_found")
		admin.do("DELETE", p, nil).expectError(http.StatusNotFound, "not_found")
		admin.do("POST", p+"/revoke-sessions", nil).expectError(http.StatusNotFound, "not_found")
		admin.do("GET", p+"/credentials", nil).expectError(http.StatusNotFound, "not_found")
		admin.do("DELETE", p+"/credentials/YQ", nil).expectError(http.StatusNotFound, "not_found")
	}
}

func TestAdminCannotDemoteOrDeleteSelf(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	e.createUser("other", "pw", true)
	admin := e.basic("root", "pw")
	self := fmt.Sprintf("/api/v1/admin/users/%d", root.ID)

	admin.do("PATCH", self, map[string]any{"is_admin": false}).expectError(http.StatusBadRequest, "invalid_request")
	admin.do("PATCH", self, map[string]any{"is_admin": false, "password": "changed"}).expectError(http.StatusBadRequest, "invalid_request")
	admin.do("DELETE", self, nil).expectError(http.StatusBadRequest, "invalid_request")

	me := admin.do("GET", "/api/v1/me", nil).expect(http.StatusOK).user()
	if !me.IsAdmin {
		t.Fatal("root lost administrator rights")
	}
	// Re-asserting admin and changing one's own password are allowed.
	admin.do("PATCH", self, map[string]any{"is_admin": true}).expect(http.StatusOK)
	admin.do("PATCH", self, map[string]any{"password": "new"}).expect(http.StatusOK)
	e.basic("root", "new").do("GET", "/api/v1/me", nil).expect(http.StatusOK)

	// Another admin may demote and delete root.
	other := e.basic("other", "pw")
	other.do("PATCH", self, map[string]any{"is_admin": false}).expect(http.StatusOK)
	other.do("DELETE", self, nil).expect(http.StatusNoContent)
}
