package api

// Patterns returns the ServeMux pattern of every route, for documentation
// checks.
func (s *Server) Patterns() []string {
	table := s.routeTable()
	out := make([]string, len(table))
	for i, rt := range table {
		out[i] = rt.pattern
	}
	return out
}
