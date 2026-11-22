package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/riba2534/passkey-box/server/internal/store"
)

// Paging of event lists (docs/API.md).
const (
	defaultEventLimit = 50
	maxEventLimit     = 200
	recentEvents      = 10
)

type auditCredentialView struct {
	ID       string `json:"id"`
	RPID     string `json:"rp_id"`
	UserName string `json:"user_name"`
}

type auditEventView struct {
	ID         int64                `json:"id"`
	At         string               `json:"at"`
	Actor      *userBriefView       `json:"actor"`
	Via        string               `json:"via"`
	Action     string               `json:"action"`
	Subject    *userBriefView       `json:"subject"`
	Target     *userBriefView       `json:"target"`
	Credential *auditCredentialView `json:"credential"`
	Detail     json.RawMessage      `json:"detail"`
}

func newAuditEventViews(events []store.AuditEvent) []auditEventView {
	out := make([]auditEventView, 0, len(events))
	for _, e := range events {
		v := auditEventView{
			ID:      e.ID,
			At:      formatTime(e.At),
			Actor:   newUserBriefPtr(e.Actor),
			Via:     e.Via,
			Action:  e.Action,
			Subject: newUserBriefPtr(e.Subject),
			Target:  newUserBriefPtr(e.Target),
			Detail:  e.Detail,
		}
		if c := e.Credential; c != nil {
			v.Credential = &auditCredentialView{ID: c.ID, RPID: c.RPID, UserName: c.UserName}
		}
		out = append(out, v)
	}
	return out
}

// queryID parses the optional positive integer parameter name; 0 means absent.
// It answers 400 and returns false when the value is not a positive integer.
func queryID(w http.ResponseWriter, q url.Values, name string) (int64, bool) {
	v := q.Get(name)
	if v == "" {
		return 0, true
	}
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil || id < 1 {
		badRequest(w, name+" must be a positive integer")
		return 0, false
	}
	return id, true
}

// readEventPage sets the before and limit parameters of f. It answers 400 and
// returns false when they are invalid.
func readEventPage(w http.ResponseWriter, q url.Values, f *store.AuditFilter) bool {
	before, ok := queryID(w, q, "before")
	if !ok {
		return false
	}
	f.Before, f.Limit = before, defaultEventLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > maxEventLimit {
			badRequest(w, fmt.Sprintf("limit must be between 1 and %d", maxEventLimit))
			return false
		}
		f.Limit = n
	}
	return true
}

// writeEvents answers a page of the events f selects. next_before is set when
// older events remain.
// writeEvents answers a page of events. hideNotes replaces the text of
// administrators' notes in user.update events with true, for callers who may
// not read notes.
func (s *Server) writeEvents(w http.ResponseWriter, r *http.Request, f store.AuditFilter, hideNotes bool) {
	limit := f.Limit
	f.Limit++
	events, err := s.opts.Store.ListAudit(r.Context(), f)
	if err != nil {
		s.internalError(w, err)
		return
	}
	if hideNotes {
		for i := range events {
			events[i].Detail = withoutNoteText(events[i].Action, events[i].Detail)
		}
	}
	var next *int64
	if len(events) > limit {
		events = events[:limit]
		next = &events[limit-1].ID
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": newAuditEventViews(events), "next_before": next})
}

func (s *Server) handleMyActivity(w http.ResponseWriter, r *http.Request, c *caller) {
	f := store.AuditFilter{UserID: c.User.ID}
	if !readEventPage(w, r.URL.Query(), &f) {
		return
	}
	// The note is the administrators' note about the user (docs/API.md).
	s.writeEvents(w, r, f, !c.User.IsAdmin)
}

// withoutNoteText returns detail with the from/to of a user.update note
// change replaced by true.
func withoutNoteText(action string, detail json.RawMessage) json.RawMessage {
	if action != "user.update" {
		return detail
	}
	var d map[string]json.RawMessage
	var changes map[string]json.RawMessage
	if json.Unmarshal(detail, &d) != nil || json.Unmarshal(d["changes"], &changes) != nil || changes["note"] == nil {
		return detail
	}
	changes["note"] = json.RawMessage("true")
	d["changes"], _ = json.Marshal(changes)
	out, err := json.Marshal(d)
	if err != nil {
		return detail
	}
	return out
}

func (s *Server) handleAdminAudit(w http.ResponseWriter, r *http.Request, _ *caller) {
	q := r.URL.Query()
	f := store.AuditFilter{Action: q.Get("action"), CredentialID: q.Get("credential_id")}
	var ok bool
	if f.UserID, ok = queryID(w, q, "user_id"); !ok {
		return
	}
	if f.ActorID, ok = queryID(w, q, "actor_id"); !ok {
		return
	}
	if !readEventPage(w, q, &f) {
		return
	}
	s.writeEvents(w, r, f, false)
}

func (s *Server) handleUserDirectory(w http.ResponseWriter, r *http.Request, _ *caller) {
	users, err := s.opts.Store.Directory(r.Context())
	if err != nil {
		s.internalError(w, err)
		return
	}
	views := make([]userBriefView, 0, len(users))
	for _, u := range users {
		views = append(views, newUserBriefView(u))
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": views})
}

func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request, _ *caller) {
	ctx := r.Context()
	o, err := s.opts.Store.Overview(ctx)
	if err != nil {
		s.internalError(w, err)
		return
	}
	events, err := s.opts.Store.ListAudit(ctx, store.AuditFilter{Limit: recentEvents})
	if err != nil {
		s.internalError(w, err)
		return
	}
	type site struct {
		RPID        string `json:"rp_id"`
		Credentials int    `json:"credentials"`
		Owners      int    `json:"owners"`
	}
	sites := make([]site, 0, len(o.Sites))
	for _, st := range o.Sites {
		sites = append(sites, site{RPID: st.RPID, Credentials: st.Credentials, Owners: st.Owners})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users": map[string]int{"total": o.Users.Total, "admins": o.Users.Admins, "disabled": o.Users.Disabled},
		"credentials": map[string]int{"total": o.Credentials.Total, "shared": o.Credentials.Shared,
			"shares": o.Credentials.Shares, "sites": o.Credentials.Sites},
		"sites":         sites,
		"recent_events": newAuditEventViews(events),
	})
}
