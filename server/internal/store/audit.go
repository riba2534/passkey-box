package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

// Actor is who performs a change: a user and the way they authenticated
// ("session", "basic", "token:<name>"), or the system (ID 0, Via "system").
type Actor struct {
	ID   int64
	Name string
	Via  string
}

// SystemActor is the actor of changes the server makes by itself, such as
// creating the bootstrap administrator.
var SystemActor = Actor{Via: "system"}

// AuditCredential names the credential an audit event is about.
type AuditCredential struct {
	ID       string
	RPID     string
	UserName string
}

// AuditEntry is an event to record; see CONTRACT/docs for the actions.
type AuditEntry struct {
	Action     string
	Subject    *UserBrief
	Target     *UserBrief
	Credential *AuditCredential
	// Detail is marshalled to a JSON object; nil records {}.
	Detail any
}

// AuditEvent is a recorded event.
type AuditEvent struct {
	ID         int64
	At         time.Time
	Actor      *UserBrief // nil for the system
	Via        string
	Action     string
	Subject    *UserBrief
	Target     *UserBrief
	Credential *AuditCredential
	Detail     json.RawMessage
}

// writeAudit records e in the same transaction as the change it describes, so
// a rolled back change (including a dry run) leaves no event behind.
func writeAudit(ctx context.Context, q queryer, now time.Time, actor Actor, e AuditEntry) error {
	detail := []byte("{}")
	if e.Detail != nil {
		b, err := json.Marshal(e.Detail)
		if err != nil {
			return err
		}
		if string(b) != "null" {
			detail = b
		}
	}
	ref := func(u *UserBrief) (sql.NullInt64, string) {
		if u == nil {
			return sql.NullInt64{}, ""
		}
		return sql.NullInt64{Int64: u.ID, Valid: true}, u.Username
	}
	actorID := sql.NullInt64{Int64: actor.ID, Valid: actor.ID != 0}
	subjectID, subjectName := ref(e.Subject)
	targetID, targetName := ref(e.Target)
	var credID, rpID, account string
	if e.Credential != nil {
		credID, rpID, account = e.Credential.ID, e.Credential.RPID, e.Credential.UserName
	}
	_, err := q.ExecContext(ctx, `INSERT INTO audit_log
		(at, actor_id, actor_name, via, action, subject_id, subject_name, target_id, target_name,
		 credential_id, rp_id, account, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		toMillis(now), actorID, actor.Name, actor.Via, e.Action, subjectID, subjectName, targetID, targetName,
		credID, rpID, account, string(detail))
	return err
}

// AuditFilter selects events for ListAudit. Zero fields do not filter.
type AuditFilter struct {
	// UserID matches events where the user is the actor, subject or target.
	UserID  int64
	ActorID int64
	// Action matches exactly, or as a prefix when it ends with ".".
	Action       string
	CredentialID string
	// Before returns only events with a smaller ID (paging).
	Before int64
	// Limit caps the number of events; it must be positive.
	Limit int
}

// ListAudit returns matching events, newest first.
func (s *Store) ListAudit(ctx context.Context, f AuditFilter) ([]AuditEvent, error) {
	var where []string
	var args []any
	if f.UserID != 0 {
		where = append(where, `(actor_id = ? OR subject_id = ? OR target_id = ?)`)
		args = append(args, f.UserID, f.UserID, f.UserID)
	}
	if f.ActorID != 0 {
		where = append(where, `actor_id = ?`)
		args = append(args, f.ActorID)
	}
	if f.Action != "" {
		if strings.HasSuffix(f.Action, ".") {
			where = append(where, `substr(action, 1, ?) = ?`)
			args = append(args, len(f.Action), f.Action)
		} else {
			where = append(where, `action = ?`)
			args = append(args, f.Action)
		}
	}
	if f.CredentialID != "" {
		where = append(where, `credential_id = ?`)
		args = append(args, f.CredentialID)
	}
	if f.Before != 0 {
		where = append(where, `id < ?`)
		args = append(args, f.Before)
	}
	query := `SELECT id, at, actor_id, actor_name, via, action, subject_id, subject_name, target_id, target_name,
		credential_id, rp_id, account, detail FROM audit_log`
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, ` AND `)
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, f.Limit)
	return queryRows(ctx, s.db, scanAuditEvent, query, args...)
}

func scanAuditEvent(r rowScanner) (AuditEvent, error) {
	var (
		e                               AuditEvent
		at                              int64
		actorID, subjectID, targetID    sql.NullInt64
		actorName, subjectName, tgtName string
		credID, rpID, account, detail   string
	)
	if err := r.Scan(&e.ID, &at, &actorID, &actorName, &e.Via, &e.Action, &subjectID, &subjectName,
		&targetID, &tgtName, &credID, &rpID, &account, &detail); err != nil {
		return AuditEvent{}, err
	}
	brief := func(id sql.NullInt64, name string) *UserBrief {
		if !id.Valid {
			return nil
		}
		return &UserBrief{ID: id.Int64, Username: name}
	}
	e.At = fromMillis(at)
	e.Actor = brief(actorID, actorName)
	e.Subject = brief(subjectID, subjectName)
	e.Target = brief(targetID, tgtName)
	if credID != "" {
		e.Credential = &AuditCredential{ID: credID, RPID: rpID, UserName: account}
	}
	e.Detail = json.RawMessage(detail)
	return e, nil
}
