package api_test

import (
	"fmt"
	"net/http"
	"reflect"
	"testing"
	"time"
)

// The extension releases 0.1.0–0.5.0 cannot be upgraded remotely. They call
// these five endpoints with HTTP Basic and read the fields below. These tests
// pin the 0.5.0 status codes and response fields (name, JSON type and value);
// newer servers may only add fields.

// legacyCredentialFields are the Credential fields of 0.5.0.
var legacyCredentialFields = []string{"id", "rp_id", "rp_name", "user_handle", "user_name", "user_display_name", "alg",
	"private_key", "public_key", "sign_count", "label", "origin", "created_at", "last_used_at", "use_count"}

// legacyUserFields are the User fields of 0.5.0.
var legacyUserFields = []string{"id", "username", "is_admin", "created_at", "credential_count", "last_used_at"}

// legacyObject decodes a JSON response with a single object under key and
// checks the content type.
func legacyObject(t *testing.T, r *response, key string) map[string]any {
	t.Helper()
	if ct := r.header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var body map[string]any
	r.decode(&body)
	obj, ok := body[key].(map[string]any)
	if !ok {
		t.Fatalf("no %q object in %s", key, r.body)
	}
	return obj
}

// legacyList decodes {"credentials": [...]}.
func legacyList(t *testing.T, r *response) []map[string]any {
	t.Helper()
	r.expect(http.StatusOK)
	var body map[string][]map[string]any
	r.decode(&body)
	list, ok := body["credentials"]
	if !ok || list == nil {
		t.Fatalf("credentials missing or null in %s", r.body)
	}
	return list
}

// matchLegacy checks that got has every field in fields with exactly the
// value in want (JSON numbers are float64).
func matchLegacy(t *testing.T, what string, got, want map[string]any, fields []string) {
	t.Helper()
	for _, f := range fields {
		v, ok := got[f]
		if !ok {
			t.Errorf("%s: field %q is missing", what, f)
			continue
		}
		if w, ok := want[f]; !ok || !reflect.DeepEqual(v, w) {
			t.Errorf("%s: %s = %#v, want %#v", what, f, v, want[f])
		}
	}
}

func legacyCredential(id, rpID, handle string) map[string]any {
	return map[string]any{
		"id": id, "rp_id": rpID, "rp_name": "Example", "user_handle": handle,
		"user_name": "alice@example.com", "user_display_name": "Alice", "alg": float64(-7),
		"private_key": "cHJpdmF0ZS1rZXk", "public_key": "cHVibGljLWtleQ", "sign_count": float64(0),
		"label": "", "origin": "https://" + rpID, "created_at": "2026-11-20T03:30:00Z",
		"last_used_at": nil, "use_count": float64(0),
	}
}

func TestLegacyExtensionContract(t *testing.T) {
	w := newWorld(t)
	ext := w.as("alice")

	// GET /me
	me := legacyObject(t, ext.do("GET", "/api/v1/me", nil).expect(http.StatusOK), "user")
	wantMe := map[string]any{"id": float64(w.alice.ID), "username": "alice", "is_admin": false,
		"created_at": "2026-11-20T03:30:00Z", "credential_count": float64(0), "last_used_at": nil}
	matchLegacy(t, "GET /me", me, wantMe, legacyUserFields)

	// GET /credentials on an empty account.
	if list := legacyList(t, ext.do("GET", "/api/v1/credentials", nil)); len(list) != 0 {
		t.Fatalf("empty list = %v", list)
	}

	// POST /credentials returns the stored credential with its private key.
	body := newCred("bGVnYWN5", "GitHub.com", "dXNlcg")
	body["label"] = "work"
	want := legacyCredential("bGVnYWN5", "GitHub.com", "dXNlcg")
	want["label"] = "work"
	created := legacyObject(t, ext.do("POST", "/api/v1/credentials", body).expect(http.StatusCreated), "credential")
	matchLegacy(t, "POST /credentials", created, want, legacyCredentialFields)
	ext.do("POST", "/api/v1/credentials", newCred("bGVnYWN5", "other.com", "b3RoZXI")).expectError(http.StatusConflict, "conflict")
	ext.do("POST", "/api/v1/credentials", map[string]any{"id": "bGVnYWN5"}).expectError(http.StatusBadRequest, "invalid_request")
	ext.do("POST", "/api/v1/credentials", "{").expectError(http.StatusBadRequest, "invalid_request")

	// GET /credentials and ?rp_id= (case-insensitive) list it.
	w.advance(time.Minute)
	ext.do("POST", "/api/v1/credentials", newCred("b3RoZXI", "example.org", "Mg")).expect(http.StatusCreated)
	list := legacyList(t, ext.do("GET", "/api/v1/credentials", nil))
	if len(list) != 2 || list[0]["id"] != "b3RoZXI" {
		t.Fatalf("list = %v", list)
	}
	matchLegacy(t, "GET /credentials", list[1], want, legacyCredentialFields)
	for _, q := range []string{"github.com", "GITHUB.COM", "GitHub.com"} {
		filtered := legacyList(t, ext.do("GET", "/api/v1/credentials?rp_id="+q, nil))
		if len(filtered) != 1 {
			t.Fatalf("rp_id=%s: %v", q, filtered)
		}
		matchLegacy(t, "GET /credentials?rp_id="+q, filtered[0], want, legacyCredentialFields)
	}
	if filtered := legacyList(t, ext.do("GET", "/api/v1/credentials?rp_id=gitlab.com", nil)); len(filtered) != 0 {
		t.Fatalf("rp_id=gitlab.com: %v", filtered)
	}

	// POST /credentials/{id}/use: 204 without a body; the statistics follow.
	w.advance(9 * time.Minute)
	used := ext.do("POST", "/api/v1/credentials/bGVnYWN5/use", nil).expect(http.StatusNoContent)
	if len(used.body) != 0 {
		t.Fatalf("204 with a body: %q", used.body)
	}
	ext.do("POST", "/api/v1/credentials/bm9uZQ/use", nil).expectError(http.StatusNotFound, "not_found")
	want["use_count"], want["last_used_at"] = float64(1), "2026-11-20T03:40:00Z"
	matchLegacy(t, "GET /credentials after use", legacyList(t, ext.do("GET", "/api/v1/credentials?rp_id=github.com", nil))[0], want, legacyCredentialFields)
	wantMe["credential_count"], wantMe["last_used_at"] = float64(2), "2026-11-20T03:40:00Z"
	matchLegacy(t, "GET /me after use", legacyObject(t, ext.do("GET", "/api/v1/me", nil).expect(http.StatusOK), "user"), wantMe, legacyUserFields)

	// DELETE /credentials/{id}: 204, then 404.
	deleted := ext.do("DELETE", "/api/v1/credentials/bGVnYWN5", nil).expect(http.StatusNoContent)
	if len(deleted.body) != 0 {
		t.Fatalf("204 with a body: %q", deleted.body)
	}
	ext.do("DELETE", "/api/v1/credentials/bGVnYWN5", nil).expectError(http.StatusNotFound, "not_found")
	if list := legacyList(t, ext.do("GET", "/api/v1/credentials", nil)); len(list) != 1 || list[0]["id"] != "b3RoZXI" {
		t.Fatalf("after delete = %v", list)
	}

	// Wrong passwords are 401 without a browser login prompt.
	bad := w.basic("alice", "wrong")
	for _, ep := range []struct{ method, path string }{
		{"GET", "/api/v1/me"}, {"GET", "/api/v1/credentials"}, {"GET", "/api/v1/credentials?rp_id=github.com"},
		{"POST", "/api/v1/credentials"}, {"POST", "/api/v1/credentials/b3RoZXI/use"}, {"DELETE", "/api/v1/credentials/b3RoZXI"},
	} {
		r := bad.do(ep.method, ep.path, nil)
		r.expectError(http.StatusUnauthorized, "unauthorized")
		if h := r.header.Get("WWW-Authenticate"); h != "" {
			t.Errorf("%s %s: WWW-Authenticate = %q", ep.method, ep.path, h)
		}
	}
}

// An old extension signed in as a share recipient sees the shared passkey
// with its private key, can sign with it and can remove it from its own list,
// which leaves the owner's credential alone.
func TestLegacyExtensionAsShareRecipient(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "c2hhcmVk", "github.com", "dXNlcg")
	w.shareWith("alice", "c2hhcmVk", "bob")
	ext := w.as("bob")
	want := legacyCredential("c2hhcmVk", "github.com", "dXNlcg")

	for _, path := range []string{"/api/v1/credentials", "/api/v1/credentials?rp_id=GitHub.com"} {
		list := legacyList(t, ext.do("GET", path, nil))
		if len(list) != 1 {
			t.Fatalf("%s: %v", path, list)
		}
		matchLegacy(t, "recipient GET "+path, list[0], want, legacyCredentialFields)
	}

	w.advance(10 * time.Minute)
	ext.do("POST", "/api/v1/credentials/c2hhcmVk/use", nil).expect(http.StatusNoContent)
	want["use_count"], want["last_used_at"] = float64(1), "2026-11-20T03:40:00Z"
	matchLegacy(t, "recipient after use", legacyList(t, ext.do("GET", "/api/v1/credentials", nil))[0], want, legacyCredentialFields)
	// Bob's statistics count only what he owns, as before.
	me := legacyObject(t, ext.do("GET", "/api/v1/me", nil).expect(http.StatusOK), "user")
	matchLegacy(t, "recipient GET /me", me, map[string]any{"id": float64(w.bob.ID), "username": "bob", "is_admin": false,
		"created_at": "2026-11-20T03:30:00Z", "credential_count": float64(0), "last_used_at": nil}, legacyUserFields)

	ext.do("DELETE", "/api/v1/credentials/c2hhcmVk", nil).expect(http.StatusNoContent)
	if list := legacyList(t, ext.do("GET", "/api/v1/credentials", nil)); len(list) != 0 {
		t.Fatalf("bob still lists %v", list)
	}
	ext.do("DELETE", "/api/v1/credentials/c2hhcmVk", nil).expectError(http.StatusNotFound, "not_found")
	ext.do("POST", "/api/v1/credentials/c2hhcmVk/use", nil).expectError(http.StatusNotFound, "not_found")

	owner := legacyList(t, w.as("alice").do("GET", "/api/v1/credentials", nil))
	if len(owner) != 1 {
		t.Fatalf("alice lost her credential: %v", owner)
	}
	matchLegacy(t, "owner after the recipient left", owner[0], want, legacyCredentialFields)
	if sw := fmt.Sprint(owner[0]["shared_with"]); sw != "[]" {
		t.Fatalf("shared_with = %s", sw)
	}
}
