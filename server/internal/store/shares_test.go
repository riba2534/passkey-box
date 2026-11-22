package store

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"testing"
)

func batchItems(t *testing.T, err error) []ItemError {
	t.Helper()
	var be *BatchError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want a *BatchError", err)
	}
	return be.Items
}

func TestShareBatch(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol", "dave", "root")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("alice", "Yg", "b.com", "Mg", 0)
	f.save("bob", "Yw", "c.com", "Mw", 0)
	f.share("bob", "Yw", "alice")
	f.share("alice", "Yg", "carol")
	if err := f.s.SetDisabled(ctx, f.users["dave"].ID, true); err != nil {
		t.Fatal(err)
	}
	before := f.auditCount("")

	// Every kind of failed entry is reported, and nothing is applied.
	_, err := f.s.ShareCredentials(ctx, f.batch("alice", "YQ", "Yw", "bogus", "YQ"),
		[]UserKey{{Username: "BOB"}, {ID: f.users["alice"].ID}, {Username: "nobody"}, {ID: f.users["bob"].ID}})
	want := []ItemError{
		{Field: "ids", Index: 1, Value: "Yw", Code: CodeForbidden, Message: "only the owner can do this"},
		{Field: "ids", Index: 2, Value: "bogus", Code: CodeNotFound, Message: "credential not found"},
		{Field: "ids", Index: 3, Value: "YQ", Code: CodeInvalid, Message: "duplicate item"},
		{Field: "users", Index: 2, Value: "nobody", Code: CodeNotFound, Message: "user not found"},
		{Field: "users", Index: 3, Value: f.users["bob"].ID, Code: CodeInvalid, Message: "duplicate item"},
		{Field: "users", Index: 1, Value: f.users["alice"].ID, Code: CodeInvalid, Message: "user owns this credential"},
	}
	if got := batchItems(t, err); !reflect.DeepEqual(got, want) {
		t.Fatalf("items = %+v\nwant    %+v", got, want)
	}
	if got := shareNames(f.get("YQ")); got != nil || f.auditCount("") != before {
		t.Fatalf("a failed batch changed something: shares %v", got)
	}

	keys := []UserKey{{Username: "carol"}, {Username: "dave"}}
	run := func(dryRun bool) []ShareResult {
		b := f.batch("alice", "YQ", "Yg")
		b.DryRun = dryRun
		res, err := f.s.ShareCredentials(ctx, b, keys)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	dry := run(true)
	if got := shareNames(f.get("YQ")); got != nil || f.auditCount("") != before {
		t.Fatalf("dry run changed something: shares %v", got)
	}
	res := run(false)
	if !reflect.DeepEqual(dry, res) {
		t.Fatalf("dry run = %+v\nreal    = %+v", dry, res)
	}
	alice := UserBrief{ID: f.users["alice"].ID, Username: "alice"}
	wantRes := []ShareResult{
		{CredentialBrief{"YQ", "a.com", "YQ@example.com", alice}, f.users["carol"].Brief(), StatusShared, []string{}},
		{CredentialBrief{"YQ", "a.com", "YQ@example.com", alice}, f.users["dave"].Brief(), StatusShared, []string{"user is disabled"}},
		{CredentialBrief{"Yg", "b.com", "Yg@example.com", alice}, f.users["carol"].Brief(), StatusUnchanged, []string{}},
		{CredentialBrief{"Yg", "b.com", "Yg@example.com", alice}, f.users["dave"].Brief(), StatusShared, []string{"user is disabled"}},
	}
	if !reflect.DeepEqual(res, wantRes) {
		t.Fatalf("results = %+v\nwant      %+v", res, wantRes)
	}
	ev, _ := f.s.ListAudit(ctx, AuditFilter{Action: "credential.share", Limit: 10})
	if len(ev) != 5 || ev[0].Target.Username != "dave" || ev[0].Credential.ID != "Yg" || ev[0].Subject.Username != "alice" ||
		ev[0].Actor.Username != "alice" {
		t.Fatalf("share events = %+v", ev)
	}

	// Administrators share anyone's credentials; the owner is still refused.
	b := f.batch("root", "Yw", "YQ")
	b.Admin = true
	if _, err := f.s.ShareCredentials(ctx, b, []UserKey{{Username: "carol"}, {Username: "bob"}}); err == nil ||
		!reflect.DeepEqual(batchItems(t, err), []ItemError{{Field: "users", Index: 1, Value: "bob", Code: CodeInvalid, Message: "user owns this credential"}}) {
		t.Fatalf("admin share to the owner = %v", err)
	}
	if res, err := f.s.ShareCredentials(ctx, b, []UserKey{{Username: "carol"}}); err != nil || res[0].Status != StatusShared || res[1].Status != StatusUnchanged {
		t.Fatalf("admin share = %+v, %v", res, err)
	}
}

func TestUnshareBatch(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("alice", "Yg", "b.com", "Mg", 0)
	f.save("bob", "Yw", "c.com", "Mw", 0)
	f.share("alice", "YQ", "bob", "carol")
	f.share("bob", "Yw", "alice")

	if _, err := f.s.UnshareCredentials(ctx, f.batch("alice", "YQ", "Yw"), nil, true); err == nil ||
		batchItems(t, err)[0].Code != CodeForbidden {
		t.Fatalf("recipient unshare = %v", err)
	}
	res, err := f.s.UnshareCredentials(ctx, f.batch("alice", "YQ", "Yg"), []UserKey{{Username: "carol"}}, false)
	if err != nil || len(res) != 2 || res[0].Status != StatusUnshared || res[1].Status != StatusUnchanged || res[1].Warnings == nil {
		t.Fatalf("unshare = %+v, %v", res, err)
	}
	f.share("alice", "Yg", "carol")
	res, err = f.s.UnshareCredentials(ctx, f.batch("alice", "YQ", "Yg"), nil, true)
	var got []string
	for _, r := range res {
		got = append(got, r.Credential.ID+":"+r.User.Username+":"+r.Status)
	}
	if err != nil || !slices.Equal(got, []string{"YQ:bob:unshared", "Yg:carol:unshared"}) {
		t.Fatalf("unshare all = %v, %v", got, err)
	}
	if res, err := f.s.UnshareCredentials(ctx, f.batch("alice", "YQ"), nil, true); err != nil || res == nil || len(res) != 0 {
		t.Fatalf("unshare all without shares = %#v, %v", res, err)
	}
	ev, _ := f.s.ListAudit(ctx, AuditFilter{Action: "credential.unshare", Limit: 10})
	if len(ev) != 3 || ev[0].Target.Username != "carol" || ev[0].Subject.Username != "alice" {
		t.Fatalf("unshare events = %+v", ev)
	}
}

func TestTransferBatch(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol", "root")
	ctx := t.Context()
	f.save("alice", "cGxhaW4", "a.com", "MQ", 0) // plain
	f.save("alice", "a2VlcA", "b.com", "Mg", 0)  // keep_access
	f.save("alice", "cmVjaXA", "c.com", "Mw", 0) // bob is a recipient
	f.save("alice", "ZHVw", "D.com", "NA", 0)    // bob has the same account
	f.save("bob", "Ym9i", "d.com", "NA", 0)
	f.share("alice", "cGxhaW4", "carol")
	f.share("alice", "cmVjaXA", "bob", "carol")
	if err := f.s.SetDisabled(ctx, f.users["bob"].ID, true); err != nil {
		t.Fatal(err)
	}
	bob := UserKey{Username: "bob"}

	if _, err := f.s.TransferCredentials(ctx, f.batch("alice", "cGxhaW4", "Ym9i"), UserKey{Username: "nobody"}, false); err == nil ||
		!reflect.DeepEqual(batchItems(t, err), []ItemError{
			{Field: "ids", Index: 1, Value: "Ym9i", Code: CodeNotFound, Message: "credential not found"},
			{Field: "to", Index: 0, Value: "nobody", Code: CodeNotFound, Message: "user not found"},
		}) {
		t.Fatalf("bad transfer = %v", err)
	}

	before := f.auditCount("")
	dry := f.batch("alice", "cGxhaW4", "cmVjaXA", "ZHVw")
	dry.DryRun = true
	dryRes, err := f.s.TransferCredentials(ctx, dry, bob, false)
	if err != nil || f.get("cGxhaW4").Owner.Username != "alice" || f.auditCount("") != before {
		t.Fatalf("dry run = %+v, %v", dryRes, err)
	}

	res, err := f.s.TransferCredentials(ctx, f.batch("alice", "cGxhaW4", "cmVjaXA", "ZHVw"), bob, false)
	if err != nil || !reflect.DeepEqual(res, dryRes) {
		t.Fatalf("transfer = %+v, %v\ndry run  %+v", res, err, dryRes)
	}
	alice, bobBrief := f.users["alice"].Brief(), f.users["bob"].Brief()
	for i, want := range [][]string{
		{"user is disabled"},
		{"user is disabled"},
		{"user is disabled", "bob already has a passkey for this account"},
	} {
		r := res[i]
		if r.Status != StatusTransferred || r.From != alice || r.To != bobBrief || r.Credential.Owner != alice || r.KeepAccess ||
			!slices.Equal(r.Warnings, want) {
			t.Errorf("result %d = %+v", i, r)
		}
	}
	// Plain: the owner changes, other shares stay, alice loses access.
	if c := f.get("cGxhaW4"); c.Owner != bobBrief || !slices.Equal(shareNames(c), []string{"carol"}) {
		t.Fatalf("plain transfer = %+v", c)
	}
	if _, err := f.s.GetCredential(ctx, alice.ID, "cGxhaW4"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("alice still reaches the transferred credential: %v", err)
	}
	// The new owner's own share is dropped.
	if c := f.get("cmVjaXA"); !slices.Equal(shareNames(c), []string{"carol"}) {
		t.Fatalf("recipient transfer shares = %v", shareNames(c))
	}
	// Both credentials for the same account are kept.
	if creds, _ := f.s.ListAccessibleCredentials(ctx, bobBrief.ID, AccessFilter{RPID: "d.com"}); len(creds) != 2 {
		t.Fatalf("bob's d.com credentials = %d", len(creds))
	}

	// keep_access: alice becomes a recipient, shared by the actor.
	b := f.batch("root", "a2VlcA", "cGxhaW4")
	b.Admin = true
	res, err = f.s.TransferCredentials(ctx, b, UserKey{Username: "carol"}, true)
	if err != nil || res[0].Status != StatusTransferred || !res[0].KeepAccess || res[1].From != bobBrief {
		t.Fatalf("keep_access transfer = %+v, %v", res, err)
	}
	c := f.get("a2VlcA")
	if c.Owner.Username != "carol" || len(c.Shares) != 1 || c.Shares[0].User != alice || c.Shares[0].SharedBy.Username != "root" ||
		!c.Shares[0].SharedAt.Equal(b.Now) {
		t.Fatalf("keep_access = %+v", c)
	}
	if c := f.get("cGxhaW4"); c.Owner.Username != "carol" || !slices.Equal(shareNames(c), []string{"bob"}) {
		t.Fatalf("carol's former share = %+v", c)
	}

	// Transferring to the owner changes nothing; recipients may not transfer.
	if res, err := f.s.TransferCredentials(ctx, f.batch("carol", "a2VlcA"), UserKey{Username: "CAROL"}, true); err != nil ||
		res[0].Status != StatusUnchanged || len(f.get("a2VlcA").Shares) != 1 {
		t.Fatalf("transfer to the owner = %+v, %v", res, err)
	}
	if _, err := f.s.TransferCredentials(ctx, f.batch("alice", "a2VlcA"), UserKey{Username: "alice"}, false); err == nil ||
		batchItems(t, err)[0].Code != CodeForbidden {
		t.Fatalf("recipient transfer = %v", err)
	}

	ev, _ := f.s.ListAudit(ctx, AuditFilter{Action: "credential.transfer", Limit: 10})
	if len(ev) != 5 || ev[0].Subject.Username != "bob" || ev[0].Target.Username != "carol" || ev[0].Actor.Username != "root" {
		t.Fatalf("transfer events = %+v", ev)
	}
	var detail map[string]any
	if err := json.Unmarshal(ev[0].Detail, &detail); err != nil || detail["keep_access"] != true {
		t.Fatalf("detail = %s", ev[0].Detail)
	}
}

func TestLeaveAndDeleteBatches(t *testing.T) {
	f := newFixture(t, "alice", "bob", "root")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("alice", "Yg", "b.com", "Mg", 0)
	f.save("bob", "Yw", "c.com", "Mw", 0)
	f.save("bob", "ZA", "d.com", "NA", 0)
	f.share("bob", "Yw", "alice")
	f.share("bob", "ZA", "alice")

	if _, err := f.s.LeaveCredentials(ctx, f.batch("alice", "Yw", "YQ")); err == nil ||
		!reflect.DeepEqual(batchItems(t, err), []ItemError{{Field: "ids", Index: 1, Value: "YQ", Code: CodeNotFound, Message: "credential is not shared with you"}}) {
		t.Fatalf("leave own = %v", err)
	}
	res, err := f.s.LeaveCredentials(ctx, f.batch("alice", "Yw"))
	if err != nil || len(res) != 1 || res[0].Status != StatusLeft || res[0].Credential.Owner.Username != "bob" {
		t.Fatalf("leave = %+v, %v", res, err)
	}
	if c := f.get("Yw"); len(c.Shares) != 0 {
		t.Fatalf("shares after leave = %+v", c.Shares)
	}

	res, err = f.s.DeleteCredentials(ctx, f.batch("alice", "YQ", "ZA"))
	if err != nil || res[0].Status != StatusDeleted || res[1].Status != StatusLeft {
		t.Fatalf("delete = %+v, %v", res, err)
	}
	if _, err := f.s.GetAnyCredential(ctx, "YQ"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted credential = %v", err)
	}
	if c := f.get("ZA"); c.Owner.Username != "bob" || len(c.Shares) != 0 {
		t.Fatalf("left credential = %+v", c)
	}
	if _, err := f.s.DeleteCredentials(ctx, f.batch("alice", "Yw")); err == nil || batchItems(t, err)[0].Code != CodeNotFound {
		t.Fatalf("delete a stranger's credential = %v", err)
	}

	f.share("bob", "Yw", "alice")
	b := f.batch("root", "Yg", "Yw")
	b.Admin = true
	if res, err := f.s.DeleteCredentials(ctx, b); err != nil || res[0].Status != StatusDeleted || res[1].Status != StatusDeleted {
		t.Fatalf("admin delete = %+v, %v", res, err)
	}
	// An administrator removing a user's share records an unshare, the user
	// leaving it a leave.
	f.share("bob", "ZA", "alice")
	if err := f.s.DeleteCredential(ctx, f.actor("root"), f.users["alice"].ID, "ZA", t0); err != nil {
		t.Fatal(err)
	}
	var actions []string
	ev, _ := f.s.ListAudit(ctx, AuditFilter{Action: "credential.", Limit: 20})
	for _, e := range ev[:6] {
		actions = append(actions, e.Action+":"+e.Credential.ID)
	}
	if want := []string{"credential.unshare:ZA", "credential.share:ZA", "credential.delete:Yw", "credential.delete:Yg",
		"credential.share:Yw", "credential.leave:ZA"}; !slices.Equal(actions, want) {
		t.Fatalf("events = %v, want %v", actions, want)
	}
	if ev[0].Target.Username != "alice" || ev[0].Actor.Username != "root" || ev[5].Actor.Username != "alice" || ev[5].Target.Username != "alice" {
		t.Fatalf("events = %+v", ev[:6])
	}
}
