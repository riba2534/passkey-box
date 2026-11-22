package store

import (
	"errors"
	"slices"
	"testing"
	"time"
)

// fixture is a store with users and helpers to add credentials.
type fixture struct {
	t     *testing.T
	s     *Store
	users map[string]User
}

func newFixture(t *testing.T, names ...string) *fixture {
	t.Helper()
	f := &fixture{t: t, s: openTest(t), users: map[string]User{}}
	for _, n := range names {
		f.users[n] = mustUser(t, f.s, n, n == "root")
	}
	return f
}

func (f *fixture) actor(name string) Actor {
	return Actor{ID: f.users[name].ID, Name: name, Via: "session"}
}

// save registers a credential for owner at t0 plus offset.
func (f *fixture) save(owner, id, rpID, handle string, offset time.Duration) Credential {
	f.t.Helper()
	c, err := f.s.SaveCredential(f.t.Context(), f.actor(owner), f.users[owner].ID,
		Credential{ID: id, RPID: rpID, UserHandle: handle, UserName: id + "@example.com", PrivateKey: "a2V5", Alg: -7}, t0.Add(offset))
	if err != nil {
		f.t.Fatalf("save %s: %v", id, err)
	}
	return c
}

func (f *fixture) batch(actor string, ids ...string) CredentialBatch {
	return CredentialBatch{Actor: f.actor(actor), IDs: ids, Now: t0.Add(time.Hour)}
}

func (f *fixture) share(owner string, id string, users ...string) {
	f.t.Helper()
	keys := make([]UserKey, len(users))
	for i, u := range users {
		keys[i] = UserKey{Username: u}
	}
	if _, err := f.s.ShareCredentials(f.t.Context(), f.batch(owner, id), keys); err != nil {
		f.t.Fatalf("share %s: %v", id, err)
	}
}

func (f *fixture) get(id string) Credential {
	f.t.Helper()
	c, err := f.s.GetAnyCredential(f.t.Context(), id)
	if err != nil {
		f.t.Fatalf("get %s: %v", id, err)
	}
	return c
}

func shareNames(c Credential) []string {
	var out []string
	for _, sh := range c.Shares {
		out = append(out, sh.User.Username)
	}
	return out
}

func (f *fixture) auditCount(prefix string) int {
	f.t.Helper()
	ev, err := f.s.ListAudit(f.t.Context(), AuditFilter{Action: prefix, Limit: 1000})
	if err != nil {
		f.t.Fatal(err)
	}
	return len(ev)
}

func TestSaveCredentialDropsTheSharesOfReplacedCredentials(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	ctx := t.Context()
	f.save("alice", "b2xk", "GitHub.com", "aA", 0)
	f.share("alice", "b2xk", "bob")
	f.share("alice", "b2xk", "carol")
	if err := f.s.MarkCredentialUsed(ctx, f.users["bob"].ID, "b2xk", t0.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	// Bob's own credential for the same account is not alice's to replace.
	f.save("bob", "Ym9i", "github.com", "aA", 0)

	// A conflicting ID rolls the replacement back: the old credential and
	// its shares survive.
	if _, err := f.s.SaveCredential(ctx, f.actor("alice"), f.users["alice"].ID,
		Credential{ID: "Ym9i", RPID: "github.com", UserHandle: "aA", PrivateKey: "a2V5", Alg: -7}, t0); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting save = %v", err)
	}
	if got := shareNames(f.get("b2xk")); !slices.Equal(got, []string{"bob", "carol"}) {
		t.Fatalf("shares after the failed save = %v", got)
	}

	// The new private key reaches nobody until alice shares it again.
	fresh := f.save("alice", "bmV3", "github.com", "aA", 3*time.Hour)
	if fresh.Access != AccessOwner || fresh.Owner.Username != "alice" || len(fresh.Shares) != 0 {
		t.Fatalf("replacement = %+v", fresh)
	}
	if creds, _ := f.s.ListCredentials(ctx, f.users["carol"].ID, ""); len(creds) != 0 {
		t.Fatalf("carol still sees %+v", creds)
	}
	if _, err := f.s.GetAnyCredential(ctx, "b2xk"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old credential = %v", err)
	}
	if got := f.get("Ym9i"); got.Owner.Username != "bob" || len(got.Shares) != 0 {
		t.Fatalf("bob's credential = %+v", got)
	}
	ev, _ := f.s.ListAudit(ctx, AuditFilter{Action: "credential.create", Limit: 10})
	if len(ev) != 3 || ev[0].Credential.ID != "bmV3" || ev[0].Subject.Username != "alice" || ev[0].Via != "session" {
		t.Fatalf("create events = %+v", ev)
	}
}

func TestAccessibleCredentials(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("bob", "Yg", "A.com", "Mg", time.Minute)
	f.save("carol", "Yw", "a.com", "Mw", 2*time.Minute)
	f.share("bob", "Yg", "alice", "carol")

	ids := func(fl AccessFilter) []string {
		creds, err := f.s.ListAccessibleCredentials(ctx, f.users["alice"].ID, fl)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, c := range creds {
			out = append(out, c.ID+":"+c.Access)
		}
		return out
	}
	for name, tc := range map[string]struct {
		f    AccessFilter
		want []string
	}{
		"all":    {AccessFilter{}, []string{"Yg:shared", "YQ:owner"}},
		"owned":  {AccessFilter{Access: AccessOwner}, []string{"YQ:owner"}},
		"shared": {AccessFilter{Access: AccessShared, RPID: "A.COM"}, []string{"Yg:shared"}},
		"rp_id":  {AccessFilter{RPID: "b.com"}, nil},
	} {
		if got := ids(tc.f); !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %v, want %v", name, got, tc.want)
		}
	}

	c, err := f.s.GetCredential(ctx, f.users["alice"].ID, "Yg")
	if err != nil || c.Access != AccessShared || c.SharedAt == nil || !c.SharedAt.Equal(t0.Add(time.Hour)) ||
		c.Owner.Username != "bob" || c.PrivateKey != "a2V5" {
		t.Fatalf("shared credential = %+v, %v", c, err)
	}
	if _, err := f.s.GetCredential(ctx, f.users["alice"].ID, "Yw"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("carol's credential = %v", err)
	}

	// Recipients may use but not relabel; strangers may do neither.
	if _, err := f.s.SetCredentialLabel(ctx, f.actor("alice"), f.users["alice"].ID, "Yg", "x", t0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("recipient label = %v", err)
	}
	if _, err := f.s.SetCredentialLabel(ctx, f.actor("alice"), f.users["alice"].ID, "Yw", "x", t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger label = %v", err)
	}
	if err := f.s.MarkCredentialUsed(ctx, f.users["alice"].ID, "Yw", t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger use = %v", err)
	}
	used := t0.Add(5 * time.Hour)
	if err := f.s.MarkCredentialUsed(ctx, f.users["alice"].ID, "Yg", used); err != nil {
		t.Fatal(err)
	}
	c = f.get("Yg")
	if c.UseCount != 1 || !c.LastUsedAt.Equal(used) || c.Shares[0].User.Username != "alice" ||
		!c.Shares[0].LastUsedAt.Equal(used) || c.Shares[1].LastUsedAt != nil {
		t.Fatalf("after use = %+v", c)
	}
	if f.auditCount("credential.update") != 0 {
		t.Fatal("refused label changes were recorded")
	}
}

func TestListAllCredentials(t *testing.T) {
	f := newFixture(t, "alice", "Bob", "carol")
	ctx := t.Context()
	f.save("alice", "YQ", "GitHub.com", "MQ", 0)
	f.save("alice", "Yg", "gitlab.com", "Mg", time.Minute)
	f.save("Bob", "Yw", "example.org", "Mw", 2*time.Minute)
	f.save("carol", "ZA", "github.com", "NA", 3*time.Minute)
	f.share("alice", "YQ", "Bob")
	f.share("carol", "ZA", "Bob", "alice")
	if _, err := f.s.AdminSetCredentialLabel(ctx, SystemActor, "Yw", "Ünïcode Wörk", t0); err != nil {
		t.Fatal(err)
	}

	yes, no := true, false
	list := func(fl CredentialFilter) ([]string, int) {
		if fl.Limit == 0 {
			fl.Limit = 100
		}
		creds, total, err := f.s.ListAllCredentials(ctx, fl)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, c := range creds {
			ids = append(ids, c.ID)
		}
		return ids, total
	}
	for name, tc := range map[string]struct {
		f    CredentialFilter
		want []string
	}{
		"all":                   {CredentialFilter{}, []string{"ZA", "Yw", "Yg", "YQ"}},
		"owner":                 {CredentialFilter{Owner: "ALICE"}, []string{"Yg", "YQ"}},
		"owner id":              {CredentialFilter{OwnerID: f.users["Bob"].ID}, []string{"Yw"}},
		"unknown owner":         {CredentialFilter{Owner: "nobody"}, nil},
		"invalid owner":         {CredentialFilter{Owner: string(make([]byte, 70))}, nil},
		"unknown owner id":      {CredentialFilter{OwnerID: 999}, nil},
		"shared with":           {CredentialFilter{SharedWith: "bob"}, []string{"ZA", "YQ"}},
		"shared with id":        {CredentialFilter{SharedWithID: f.users["alice"].ID}, []string{"ZA"}},
		"unknown shared with":   {CredentialFilter{SharedWith: "nobody"}, nil},
		"rp_id":                 {CredentialFilter{RPID: "GITHUB.com"}, []string{"ZA", "YQ"}},
		"q rp_id":               {CredentialFilter{Query: "GITLAB"}, []string{"Yg"}},
		"q user_name":           {CredentialFilter{Query: "zA@EXAMPLE"}, []string{"ZA"}},
		"q label":               {CredentialFilter{Query: "wörk"}, []string{"Yw"}},
		"q owner":               {CredentialFilter{Query: "caro"}, []string{"ZA"}},
		"q owner case":          {CredentialFilter{Query: "BO"}, []string{"Yw"}},
		"shared":                {CredentialFilter{Shared: &yes}, []string{"ZA", "YQ"}},
		"not shared":            {CredentialFilter{Shared: &no}, []string{"Yw", "Yg"}},
		"combined":              {CredentialFilter{Owner: "alice", Shared: &no}, []string{"Yg"}},
		"owner and id disagree": {CredentialFilter{Owner: "alice", OwnerID: f.users["Bob"].ID}, nil},
	} {
		if got, total := list(tc.f); !slices.Equal(got, tc.want) || total != len(tc.want) {
			t.Errorf("%s: got %v (total %d), want %v", name, got, total, tc.want)
		}
	}

	got, total := list(CredentialFilter{Limit: 2, Offset: 1})
	if !slices.Equal(got, []string{"Yw", "Yg"}) || total != 4 {
		t.Fatalf("page = %v, total %d", got, total)
	}
	if got, total := list(CredentialFilter{Limit: 2, Offset: 4}); got != nil || total != 4 {
		t.Fatalf("past the end = %v, total %d", got, total)
	}
	creds, _, _ := f.s.ListAllCredentials(ctx, CredentialFilter{RPID: "github.com", Limit: 10})
	if creds[0].Access != "" || !slices.Equal(shareNames(creds[0]), []string{"Bob", "alice"}) || shareNames(creds[1])[0] != "Bob" {
		t.Fatalf("shares = %+v", creds)
	}
}

func TestSharesGoWithCredentialAndUser(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("alice", "Yg", "b.com", "Mg", 0)
	f.share("alice", "YQ", "bob", "carol")
	f.share("alice", "Yg", "bob")

	if err := f.s.DeleteCredential(ctx, f.actor("alice"), f.users["alice"].ID, "YQ", t0); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.s.db.QueryRow(`SELECT COUNT(*) FROM credential_shares`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("shares after deleting the credential = %d, %v", n, err)
	}
	if err := f.s.DeleteUser(ctx, SystemActor, f.users["bob"].ID, t0); err != nil {
		t.Fatal(err)
	}
	if got := f.get("Yg"); len(got.Shares) != 0 {
		t.Fatalf("shares after deleting the recipient = %+v", got.Shares)
	}

	// A share made by a since deleted administrator stays, without shared_by.
	root, _ := f.s.CreateUser(ctx, "root", "pw", true, t0)
	f.users["root"] = root
	b := f.batch("root", "Yg")
	b.Admin = true
	if _, err := f.s.ShareCredentials(ctx, b, []UserKey{{Username: "carol"}}); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteUser(ctx, SystemActor, root.ID, t0); err != nil {
		t.Fatal(err)
	}
	if got := f.get("Yg"); len(got.Shares) != 1 || got.Shares[0].User.Username != "carol" || got.Shares[0].SharedBy != nil {
		t.Fatalf("share by a deleted user = %+v", got.Shares)
	}
	if err := f.s.DeleteUser(ctx, SystemActor, f.users["alice"].ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.GetAnyCredential(ctx, "Yg"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("alice's credential after deleting her = %v", err)
	}
	if err := f.s.db.QueryRow(`SELECT COUNT(*) FROM credential_shares`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("shares after deleting the owner = %d, %v", n, err)
	}
}
