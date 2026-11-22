package api

import "net/http"

func (s *Server) handleAdminListUserCredentials(w http.ResponseWriter, r *http.Request, c *caller) {
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	s.writeCredentials(w, r, c, target.ID)
}

func (s *Server) handleAdminDeleteUserCredential(w http.ResponseWriter, r *http.Request, _ *caller) {
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	err := s.opts.Store.DeleteCredential(r.Context(), target.ID, r.PathValue("id"))
	s.writeNoContent(w, err, credentialNotFound)
}

func (s *Server) handleAdminListCredentials(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleAdminGetCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleAdminUpdateCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleAdminDeleteCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleAdminShare(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleAdminUnshare(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleAdminTransfer(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleAdminBatchDeleteCredentials(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}
