package store

import (
	"errors"
	"reflect"
	"slices"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// addCredential stores a credential directly, independent of the credential
// functions.
func addCredential(t *testing.T, s *Store, userID int64, id, rpID, account string) {
	t.Helper()
	mustExec(t, s.db, `INSERT INTO credentials (user_id, id, rp_id, rp_id_key, user_handle, user_name, alg, private_key, created_at)
		VALUES (?, ?, ?, lower(?), ?, ?, -7, 'a2V5', ?)`, userID, id, rpID, rpID, id, account, toMillis(t0))
}

// addShare shares a credential directly.
func addShare(t *testing.T, s *Store, credentialID string, userID, by int64) {
	t.Helper()
	mustExec(t, s.db, `INSERT INTO credential_shares (credential_seq, user_id, shared_by, created_at)
		SELECT seq, ?, ?, ? FROM credentials WHERE id = ?`, userID, by, toMillis(t0), credentialID)
}

func auditCount(t *testing.T, s *Store) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM audit_log`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func batchItems(t *testing.T, err error) []ItemError {
	t.Helper()
	var be *BatchError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want a *BatchError", err)
	}
	return be.Items
}

func checkItems(t *testing.T, err error, want ...ItemError) {
	t.Helper()
	if got := batchItems(t, err); !reflect.DeepEqual(got, want) {
		t.Fatalf("items:\n got %+v\nwant %+v", got, want)
	}
}

func mustUser(t *testing.T, s *Store, name string, isAdmin bool) User {
	t.Helper()
	u, err := s.CreateUser(t.Context(), name, "pw", isAdmin, t0)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// invalidCost makes every bcrypt hash fail, which shows that a call hashed
// nothing when it succeeds anyway.
const invalidCost = bcrypt.MaxCost + 1

func TestCreateUsers(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	root := mustUser(t, s, "root", true)
	actor := Actor{ID: root.ID, Name: "root", Via: "token:ops"}
	events := auditCount(t, s)

	// Invalid batches are rejected before any password is hashed.
	s.PasswordCost = invalidCost
	_, err := s.CreateUsers(ctx, actor, []NewUser{
		{Username: "alice", Password: "a"},
		{Username: "ROOT", Password: "x"},
		{Username: "Alice", Password: "b"},
		{Username: "  ", Password: "x"},
		{Username: "dave"},
	}, false, t0)
	checkItems(t, err,
		ItemError{Field: "users", Index: 1, Value: "ROOT", Code: CodeConflict, Message: "username already exists"},
		ItemError{Field: "users", Index: 2, Value: "Alice", Code: CodeConflict, Message: "username already exists"},
		ItemError{Field: "users", Index: 3, Value: "  ", Code: CodeInvalid, Message: "username must be 1-64 characters"},
		ItemError{Field: "users", Index: 4, Value: "dave", Code: CodeInvalid, Message: "password must not be empty"},
	)
	if users, _ := s.ListUsers(ctx, UserFilter{}); len(users) != 1 || auditCount(t, s) != events {
		t.Fatalf("a failed batch left %d users and %d events", len(users), auditCount(t, s)-events)
	}

	batch := []NewUser{{Username: " alice ", Password: "a", Note: "测试"}, {Username: "bob", Password: "b", IsAdmin: true}}
	// A dry run computes the users without hashing or storing anything.
	dry, err := s.CreateUsers(ctx, actor, batch, true, t0)
	if err != nil || len(dry) != 2 || dry[0].Username != "alice" || dry[0].Note != "测试" || dry[0].ID == 0 || !dry[1].IsAdmin {
		t.Fatalf("dry run = %+v, %v", dry, err)
	}
	if users, _ := s.ListUsers(ctx, UserFilter{}); len(users) != 1 || auditCount(t, s) != events {
		t.Fatalf("a dry run left %d users and %d events", len(users), auditCount(t, s)-events)
	}
	if _, err := s.CreateUsers(ctx, actor, batch, false, t0); err == nil {
		t.Fatal("a real batch must hash its passwords")
	}

	s.PasswordCost = bcrypt.MinCost
	created, err := s.CreateUsers(ctx, actor, batch, false, t0)
	if err != nil || len(created) != 2 || created[0].Username != "alice" || created[1].Username != "bob" {
		t.Fatalf("created = %+v, %v", created, err)
	}
	if u, err := s.Authenticate(ctx, "ALICE", "a"); err != nil || u.Note != "测试" || u.IsAdmin {
		t.Fatalf("alice = %+v, %v", u, err)
	}
	if u, err := s.Authenticate(ctx, "bob", "b"); err != nil || !u.IsAdmin {
		t.Fatalf("bob = %+v, %v", u, err)
	}
	ev, _ := s.ListAudit(ctx, AuditFilter{Action: "user.create", ActorID: root.ID, Limit: 10})
	if len(ev) != 2 || ev[0].Subject.Username != "bob" || string(ev[0].Detail) != `{"is_admin":true}` ||
		ev[1].Subject.ID != created[0].ID || string(ev[1].Detail) != `{"is_admin":false}` || ev[0].Via != "token:ops" {
		t.Fatalf("events = %+v", ev)
	}
}

func TestUpdateUser(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	root := mustUser(t, s, "root", true)
	alice := mustUser(t, s, "alice", false)
	actor := Actor{ID: root.ID, Name: "root", Via: "session"}

	// Renaming keeps the password but retires the old name, even when the
	// password cache has seen it.
	if _, err := s.Authenticate(ctx, "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	res, err := s.UpdateUser(ctx, actor, alice.ID, UserUpdate{Username: new(" Alicia ")}, t0)
	if err != nil || res.User.Username != "Alicia" || !slices.Equal(res.Changes, []string{"username"}) {
		t.Fatalf("rename = %+v, %v", res, err)
	}
	if _, err := s.Authenticate(ctx, "alice", "pw"); !errors.Is(err, ErrBadPassword) {
		t.Fatalf("old name = %v", err)
	}
	if _, err := s.Authenticate(ctx, "alicia", "pw"); err != nil {
		t.Fatalf("new name = %v", err)
	}

	res, err = s.UpdateUser(ctx, actor, alice.ID, UserUpdate{
		Username: new("ALICIA"), Password: new("new"), IsAdmin: new(true), Disabled: new(true), Note: new("备注"),
	}, t0)
	if err != nil || !slices.Equal(res.Changes, []string{"username", "password", "is_admin", "disabled", "note"}) {
		t.Fatalf("update = %+v, %v", res, err)
	}
	if u := res.User; u.Username != "ALICIA" || !u.IsAdmin || !u.Disabled || u.Note != "备注" {
		t.Fatalf("user = %+v", u)
	}
	if _, err := s.Authenticate(ctx, "alicia", "new"); err != nil {
		t.Fatalf("new password = %v", err)
	}
	ev, _ := s.ListAudit(ctx, AuditFilter{Action: "user.update", Limit: 1})
	const detail = `{"changes":{"disabled":{"from":false,"to":true},"is_admin":{"from":false,"to":true},` +
		`"note":{"from":"","to":"备注"},"password":true,"username":{"from":"Alicia","to":"ALICIA"}}}`
	if len(ev) != 1 || string(ev[0].Detail) != detail || ev[0].Actor.ID != root.ID || ev[0].Via != "session" ||
		*ev[0].Subject != (UserBrief{ID: alice.ID, Username: "Alicia"}) || ev[0].Target != nil {
		t.Fatalf("event = %+v %s", ev, ev[0].Detail)
	}

	// Setting fields to their current values changes nothing and records nothing.
	events := auditCount(t, s)
	res, err = s.UpdateUser(ctx, actor, alice.ID, UserUpdate{Username: new("ALICIA"), IsAdmin: new(true), Note: new("备注")}, t0)
	if err != nil || res.Changes == nil || len(res.Changes) != 0 || auditCount(t, s) != events {
		t.Fatalf("no-op update = %+v, %v", res, err)
	}

	for name, tc := range map[string]struct {
		id   int64
		u    UserUpdate
		want error // nil: an *InvalidError
	}{
		"taken name":     {alice.ID, UserUpdate{Username: new("Root")}, ErrConflict},
		"blank name":     {alice.ID, UserUpdate{Username: new(" ")}, nil},
		"empty password": {alice.ID, UserUpdate{Password: new("")}, nil},
		"demote self":    {root.ID, UserUpdate{IsAdmin: new(false), Note: new("x")}, nil},
		"disable self":   {root.ID, UserUpdate{Disabled: new(true)}, nil},
		"unknown user":   {12345, UserUpdate{Note: new("x")}, ErrNotFound},
	} {
		_, err := s.UpdateUser(ctx, actor, tc.id, tc.u, t0)
		var inv *InvalidError
		if tc.want == nil && !errors.As(err, &inv) || tc.want != nil && !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
	if u, _ := s.GetUser(ctx, root.ID); !u.IsAdmin || u.Disabled || u.Note != "" || auditCount(t, s) != events {
		t.Fatalf("rejected updates changed root: %+v", u)
	}
	// Confirming one's own role and status is fine.
	if _, err := s.UpdateUser(ctx, actor, root.ID, UserUpdate{IsAdmin: new(true), Disabled: new(false)}, t0); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateUsers(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	root := mustUser(t, s, "root", true)
	alice := mustUser(t, s, "alice", false)
	mustUser(t, s, "bob", false)
	actor := Actor{ID: root.ID, Name: "root", Via: "basic"}
	events := auditCount(t, s)

	_, err := s.UpdateUsers(ctx, actor, []UserEdit{
		{User: UserKey{Username: "alice"}, UserUpdate: UserUpdate{Note: new("x")}},
		{User: UserKey{ID: alice.ID}, UserUpdate: UserUpdate{Disabled: new(true)}},
		{User: UserKey{Username: "ghost"}, UserUpdate: UserUpdate{Note: new("x")}},
		{User: UserKey{ID: root.ID}, UserUpdate: UserUpdate{Disabled: new(true)}},
		{User: UserKey{Username: "BOB"}, UserUpdate: UserUpdate{Username: new("Alice")}},
	}, false, t0)
	checkItems(t, err,
		ItemError{Field: "items", Index: 1, Value: alice.ID, Code: CodeInvalid, Message: "duplicate item"},
		ItemError{Field: "items", Index: 2, Value: "ghost", Code: CodeNotFound, Message: "user not found"},
		ItemError{Field: "items", Index: 3, Value: root.ID, Code: CodeInvalid, Message: "you cannot disable yourself"},
		ItemError{Field: "items", Index: 4, Value: "BOB", Code: CodeConflict, Message: "username already exists"},
	)
	if u, _ := s.GetUser(ctx, alice.ID); u.Note != "" || auditCount(t, s) != events {
		t.Fatalf("a failed batch changed alice: %+v", u)
	}

	edits := []UserEdit{
		{User: UserKey{Username: "alice"}, UserUpdate: UserUpdate{Password: new("p"), Note: new("x")}},
		{User: UserKey{Username: "bob"}, UserUpdate: UserUpdate{IsAdmin: new(false)}},
	}
	s.PasswordCost = invalidCost
	dry, err := s.UpdateUsers(ctx, actor, edits, true, t0)
	if err != nil || len(dry) != 2 || !slices.Equal(dry[0].Changes, []string{"password", "note"}) || dry[0].User.Note != "x" ||
		len(dry[1].Changes) != 0 {
		t.Fatalf("dry run = %+v, %v", dry, err)
	}
	s.PasswordCost = bcrypt.MinCost
	if u, err := s.Authenticate(ctx, "alice", "pw"); err != nil || u.Note != "" || auditCount(t, s) != events {
		t.Fatalf("a dry run changed alice: %+v, %v", u, err)
	}

	if _, err := s.UpdateUsers(ctx, actor, edits, false, t0); err != nil {
		t.Fatal(err)
	}
	if u, err := s.Authenticate(ctx, "alice", "p"); err != nil || u.Note != "x" {
		t.Fatalf("alice = %+v, %v", u, err)
	}
	// bob did not change, so only alice's update is recorded.
	if ev, _ := s.ListAudit(ctx, AuditFilter{Action: "user.update", Limit: 5}); len(ev) != 1 || ev[0].Subject.ID != alice.ID {
		t.Fatalf("events = %+v", ev)
	}
}

func credentialOwner(t *testing.T, s *Store, id string) int64 {
	t.Helper()
	var owner int64
	if err := s.db.QueryRow(`SELECT user_id FROM credentials WHERE id = ?`, id).Scan(&owner); err != nil {
		t.Fatalf("credential %s: %v", id, err)
	}
	return owner
}

func shares(t *testing.T, s *Store) []string {
	t.Helper()
	rows, err := s.db.Query(`SELECT c.id || '>' || u.username FROM credential_shares sh
		JOIN credentials c ON c.seq = sh.credential_seq JOIN users u ON u.id = sh.user_id ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func TestDeleteUsers(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	root := mustUser(t, s, "root", true)
	alice := mustUser(t, s, "alice", false)
	bob := mustUser(t, s, "bob", false)
	carol := mustUser(t, s, "carol", false)
	dave := mustUser(t, s, "dave", false)
	if err := s.SetDisabled(ctx, dave.ID, true); err != nil {
		t.Fatal(err)
	}
	addCredential(t, s, alice.ID, "YTE", "GitHub.com", "alice@example.com")
	addCredential(t, s, alice.ID, "YTI", "gitlab.com", "alice")
	addCredential(t, s, bob.ID, "YjE", "github.com", "bob@example.com")
	addShare(t, s, "YTE", bob.ID, alice.ID)
	addShare(t, s, "YTI", carol.ID, alice.ID)
	addShare(t, s, "YjE", alice.ID, bob.ID)
	actor := Actor{ID: root.ID, Name: "root", Via: "token:ops"}
	events := auditCount(t, s)

	_, err := s.DeleteUsers(ctx, actor, []UserKey{{Username: "Alice"}, {ID: alice.ID}, {Username: "ghost"}, {ID: root.ID}}, &UserKey{Username: "dave"}, false, t0)
	checkItems(t, err,
		ItemError{Field: "users", Index: 1, Value: alice.ID, Code: CodeInvalid, Message: "duplicate item"},
		ItemError{Field: "users", Index: 2, Value: "ghost", Code: CodeNotFound, Message: "user not found"},
		ItemError{Field: "users", Index: 3, Value: root.ID, Code: CodeInvalid, Message: "you cannot delete yourself"},
		ItemError{Field: "transfer_credentials_to", Index: 0, Value: "dave", Code: CodeInvalid, Message: "user is disabled"},
	)
	_, err = s.DeleteUsers(ctx, actor, []UserKey{{Username: "alice"}}, &UserKey{ID: alice.ID}, false, t0)
	checkItems(t, err, ItemError{Field: "transfer_credentials_to", Index: 0, Value: alice.ID, Code: CodeInvalid, Message: "the recipient is being deleted"})
	_, err = s.DeleteUsers(ctx, actor, []UserKey{{Username: "alice"}}, &UserKey{Username: "nobody"}, false, t0)
	checkItems(t, err, ItemError{Field: "transfer_credentials_to", Index: 0, Value: "nobody", Code: CodeNotFound, Message: "user not found"})

	wantShares := []string{"YTE>bob", "YTI>carol", "YjE>alice"}
	unchanged := func(what string) {
		t.Helper()
		if _, err := s.GetUser(ctx, alice.ID); err != nil {
			t.Fatalf("%s deleted alice: %v", what, err)
		}
		if credentialOwner(t, s, "YTE") != alice.ID || !slices.Equal(shares(t, s), wantShares) || auditCount(t, s) != events {
			t.Fatalf("%s changed data: shares %v", what, shares(t, s))
		}
	}
	unchanged("failed batches")

	want := []DeletedUser{{User: alice.Brief(), Deleted: 0, Transferred: 2}}
	dry, err := s.DeleteUsers(ctx, actor, []UserKey{{Username: "alice"}}, &UserKey{Username: "bob"}, true, t0)
	if err != nil || !reflect.DeepEqual(dry, want) {
		t.Fatalf("dry run = %+v, %v", dry, err)
	}
	unchanged("a dry run")

	got, err := s.DeleteUsers(ctx, actor, []UserKey{{Username: "alice"}}, &UserKey{Username: "bob"}, false, t0)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("delete = %+v, %v", got, err)
	}
	if _, err := s.GetUser(ctx, alice.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("alice = %v", err)
	}
	if credentialOwner(t, s, "YTE") != bob.ID || credentialOwner(t, s, "YTI") != bob.ID {
		t.Fatal("alice's credentials were not handed to bob")
	}
	// Bob's own share of YTE is gone, carol keeps hers and alice's share of
	// bob's credential went with her account.
	if got := shares(t, s); !slices.Equal(got, []string{"YTI>carol"}) {
		t.Fatalf("shares = %v", got)
	}
	ev, _ := s.ListAudit(ctx, AuditFilter{ActorID: root.ID, Limit: 10})
	if len(ev) != 3 || ev[0].Action != "user.delete" || ev[1].Action != "credential.transfer" || ev[2].Action != "credential.transfer" {
		t.Fatalf("events = %+v", ev)
	}
	tr := ev[2]
	if *tr.Subject != alice.Brief() || *tr.Target != bob.Brief() || string(tr.Detail) != `{"keep_access":false}` ||
		*tr.Credential != (AuditCredential{ID: "YTE", RPID: "GitHub.com", UserName: "alice@example.com"}) || tr.Via != "token:ops" {
		t.Fatalf("transfer event = %+v", tr)
	}
	if d := ev[0]; *d.Subject != alice.Brief() || *d.Target != bob.Brief() ||
		string(d.Detail) != `{"credentials_deleted":0,"credentials_transferred":2}` {
		t.Fatalf("delete event = %+v %s", d, d.Detail)
	}

	// Without a recipient the credentials go with the account.
	got, err = s.DeleteUsers(ctx, actor, []UserKey{{ID: bob.ID}}, nil, false, t0)
	if err != nil || !reflect.DeepEqual(got, []DeletedUser{{User: bob.Brief(), Deleted: 3}}) {
		t.Fatalf("delete bob = %+v, %v", got, err)
	}
	ev, _ = s.ListAudit(ctx, AuditFilter{Action: "user.delete", Limit: 1})
	if ev[0].Target != nil || string(ev[0].Detail) != `{"credentials_deleted":3,"credentials_transferred":0}` {
		t.Fatalf("delete event = %+v %s", ev[0], ev[0].Detail)
	}
	if left := shares(t, s); len(left) != 0 {
		t.Fatalf("shares left = %v", left)
	}
}

func TestDeleteUserRefusesSelf(t *testing.T) {
	s := openTest(t)
	root := mustUser(t, s, "root", true)
	var inv *InvalidError
	if err := s.DeleteUser(t.Context(), Actor{ID: root.ID, Name: "root", Via: "session"}, root.ID, t0); !errors.As(err, &inv) {
		t.Fatalf("delete self = %v", err)
	}
	if _, err := s.GetUser(t.Context(), root.ID); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureAdminRecordsSystemEvents(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	if _, err := s.EnsureAdmin(ctx, "admin", "pw", t0); err != nil {
		t.Fatal(err)
	}
	mustUser(t, s, "ops", false)
	if _, err := s.EnsureAdmin(ctx, "OPS", "pw", t0); err != nil {
		t.Fatal(err)
	}
	// Already an administrator: nothing to record.
	if _, err := s.EnsureAdmin(ctx, "admin", "pw", t0); err != nil {
		t.Fatal(err)
	}
	ev, _ := s.ListAudit(ctx, AuditFilter{Limit: 10})
	if len(ev) != 3 {
		t.Fatalf("events = %+v", ev)
	}
	for _, e := range ev {
		if e.Actor != nil || e.Via != "system" {
			t.Fatalf("event by %+v via %q", e.Actor, e.Via)
		}
	}
	if ev[0].Action != "user.update" || ev[0].Subject.Username != "ops" ||
		string(ev[0].Detail) != `{"changes":{"is_admin":{"from":false,"to":true}}}` {
		t.Fatalf("promotion = %+v %s", ev[0], ev[0].Detail)
	}
	if ev[2].Action != "user.create" || ev[2].Subject.Username != "admin" || string(ev[2].Detail) != `{"is_admin":true}` {
		t.Fatalf("creation = %+v %s", ev[2], ev[2].Detail)
	}
}

func TestListUsersFilter(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	root := mustUser(t, s, "root", true)
	alice := mustUser(t, s, "Alice", false)
	bob := mustUser(t, s, "bob", false)
	if _, err := s.UpdateUser(ctx, SystemActor, bob.ID, UserUpdate{Note: new("Équipe ALICE"), Disabled: new(true)}, t0); err != nil {
		t.Fatal(err)
	}
	ids := func(f UserFilter) []int64 {
		users, err := s.ListUsers(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		var out []int64
		for _, u := range users {
			out = append(out, u.ID)
		}
		return out
	}
	for name, tc := range map[string]struct {
		f    UserFilter
		want []int64
	}{
		"all":                 {UserFilter{}, []int64{root.ID, alice.ID, bob.ID}},
		"name or note":        {UserFilter{Query: "aLiCe"}, []int64{alice.ID, bob.ID}},
		"non-ASCII note":      {UserFilter{Query: "équipe"}, []int64{bob.ID}},
		"admins":              {UserFilter{Admin: new(true)}, []int64{root.ID}},
		"users":               {UserFilter{Admin: new(false)}, []int64{alice.ID, bob.ID}},
		"disabled":            {UserFilter{Disabled: new(true)}, []int64{bob.ID}},
		"active matching ali": {UserFilter{Query: "ali", Disabled: new(false)}, []int64{alice.ID}},
		"no match":            {UserFilter{Query: "zed"}, nil},
	} {
		if got := ids(tc.f); !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %v, want %v", name, got, tc.want)
		}
	}
}

func TestDirectory(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	bob := mustUser(t, s, "bob", false)
	alice := mustUser(t, s, "Alice", false)
	carol := mustUser(t, s, "carol", true)
	dave := mustUser(t, s, "Dave", false)
	if err := s.SetDisabled(ctx, carol.ID, true); err != nil {
		t.Fatal(err)
	}
	got, err := s.Directory(ctx)
	if want := []UserBrief{alice.Brief(), bob.Brief(), dave.Brief()}; err != nil || !slices.Equal(got, want) {
		t.Fatalf("directory = %+v, %v; want %+v", got, err, want)
	}
}

func TestOverview(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	root := mustUser(t, s, "root", true)
	alice := mustUser(t, s, "alice", false)
	bob := mustUser(t, s, "bob", false)
	if err := s.SetDisabled(ctx, bob.ID, true); err != nil {
		t.Fatal(err)
	}
	addCredential(t, s, alice.ID, "YTE", "GitHub.com", "a1")
	addCredential(t, s, alice.ID, "YTI", "github.com", "a2")
	addCredential(t, s, alice.ID, "YTM", "gitlab.com", "a3")
	addCredential(t, s, bob.ID, "YjE", "github.com", "b1")
	addShare(t, s, "YTE", bob.ID, alice.ID)
	addShare(t, s, "YTE", root.ID, alice.ID)
	addShare(t, s, "YjE", alice.ID, bob.ID)

	o, err := s.Overview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := Overview{
		Users:       UserStats{Total: 3, Admins: 1, Disabled: 1},
		Credentials: CredentialStats{Total: 4, Shared: 2, Shares: 3, Sites: 2},
		Sites:       []SiteStats{{RPID: "github.com", Credentials: 3, Owners: 2}, {RPID: "gitlab.com", Credentials: 1, Owners: 1}},
	}
	if !reflect.DeepEqual(o, want) {
		t.Fatalf("overview:\n got %+v\nwant %+v", o, want)
	}

	// Only the 20 largest sites are listed.
	for i := range 25 {
		addCredential(t, s, root.ID, "c2l0ZQ"+string(rune('A'+i)), string(rune('a'+i))+".example", "r")
	}
	if o, _ := s.Overview(ctx); len(o.Sites) != 20 || o.Sites[0].RPID != "github.com" || o.Credentials.Sites != 27 {
		t.Fatalf("sites = %d %+v, %d distinct", len(o.Sites), o.Sites[0], o.Credentials.Sites)
	}
}
