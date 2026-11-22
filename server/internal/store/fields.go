package store

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Field is a custom field of a credential. The credentials.fields column
// holds a JSON array of them in the order the user arranged them.
type Field struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

// FieldTypes are the types a Field may have.
var FieldTypes = []string{"text", "password", "url", "email", "phone", "date", "multiline", "totp"}

// Limits of custom fields: fields per credential, and characters in a label
// (after trimming) and in a value.
const (
	MaxFields        = 50
	MaxFieldLabelLen = 100
	MaxFieldValueLen = 10000
)

var fieldIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// newFieldID returns a random field ID: 6 random bytes, base64url.
func newFieldID() string {
	buf := make([]byte, 6)
	rand.Read(buf) // never fails since Go 1.24
	return base64.RawURLEncoding.EncodeToString(buf)
}

// normalizeFields validates a new list of fields and returns it with the
// labels trimmed, date and TOTP values trimmed and every field identified:
// a well-formed ID keeps a field's identity, and a field without one, with a
// malformed one or with the ID of an earlier field gets a new ID from newID.
// Errors name the field by its index, for example "fields[3]: invalid TOTP
// secret"; a list that is too long names the first field over the limit.
func normalizeFields(fields []Field, newID func() string) ([]Field, error) {
	if len(fields) > MaxFields {
		return nil, Invalid("fields[%d]: at most %d fields are allowed", MaxFields, MaxFields)
	}
	out := make([]Field, len(fields))
	taken := map[string]bool{}
	for i, f := range fields {
		f.Label = strings.TrimSpace(f.Label)
		switch f.Type {
		case "date", "totp":
			f.Value = strings.Trim(f.Value, asciiSpace)
		case "url", "email", "phone":
			// Copied phone numbers and addresses often carry invisible
			// direction marks; dropping them also keeps a link's text from
			// reading differently from where it goes.
			f.Value = strings.Map(func(r rune) rune {
				if bidiFormatting(r) {
					return -1
				}
				return r
			}, f.Value)
		}
		if msg := checkField(f); msg != "" {
			return nil, Invalid("fields[%d]: %s", i, msg)
		}
		if !fieldIDPattern.MatchString(f.ID) || taken[f.ID] {
			f.ID = ""
		}
		taken[f.ID] = true
		out[i] = f
	}
	// New IDs are drawn once the kept ones are known, so none repeats.
	for i := range out {
		for out[i].ID == "" {
			if id := newID(); !taken[id] {
				out[i].ID = id
				taken[id] = true
			}
		}
	}
	return out, nil
}

// checkField returns what is wrong with a trimmed field, or "".
func checkField(f Field) string {
	switch {
	case !slices.Contains(FieldTypes, f.Type):
		return "type must be one of " + strings.Join(FieldTypes, ", ")
	case utf8.RuneCountInString(f.Label) > MaxFieldLabelLen:
		return fmt.Sprintf("label must be at most %d characters", MaxFieldLabelLen)
	case utf8.RuneCountInString(f.Value) > MaxFieldValueLen:
		return fmt.Sprintf("value must be at most %d characters", MaxFieldValueLen)
	case f.Type == "date" && f.Value != "":
		if _, err := time.Parse(time.DateOnly, f.Value); err != nil {
			return "date must be a valid date in YYYY-MM-DD form"
		}
	case f.Type == "totp":
		return checkTOTP(f.Value)
	case (f.Type == "url" || f.Type == "email" || f.Type == "phone") && strings.IndexFunc(f.Value, unicode.IsControl) >= 0:
		return "value must not contain control characters"
	}
	return ""
}

// bidiFormatting reports Unicode bidirectional formatting characters, which
// can make a link's text read differently from where it goes.
func bidiFormatting(r rune) bool {
	switch {
	case r == '\u061c' || r == '\u200e' || r == '\u200f':
		return true
	case r >= '\u202a' && r <= '\u202e', r >= '\u2066' && r <= '\u2069':
		return true
	}
	return false
}

// asciiLower lower-cases ASCII letters only. otpauth parameter names are
// case-insensitive by ASCII rules alone, as in the console and the extension:
// Go and JavaScript fold other letters (U+0130) differently.
func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, s)
}

var base32Pattern = regexp.MustCompile(`^[A-Za-z2-7]+$`)

// asciiSpace is the only white space TOTP values may contain. The console and
// the extension strip exactly these characters too; Go's unicode.IsSpace and
// JavaScript's \s disagree on others (U+0085, U+FEFF), which would let the
// server accept a secret no client can turn into a code.
const asciiSpace = " \t\n\r\f\v"

// validBase32 reports whether s is a TOTP secret by the rules the web console
// and the extension share: case-insensitive, ignoring white space and "-",
// with optional "=" padding at the end, at least one byte long. Lengths no
// encoder produces (1, 3 or 6 more than a multiple of 8) are refused; Go's
// decoder would silently drop their last characters. Every other string of
// base32 characters decodes to at least one byte.
func validBase32(s string) bool {
	s = strings.Map(func(r rune) rune {
		if r == '-' || strings.ContainsRune(asciiSpace, r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimRight(s, "=")
	return base32Pattern.MatchString(s) && !slices.Contains([]int{1, 3, 6}, len(s)%8)
}

const errTOTPSecret = "invalid TOTP secret"

// checkTOTP returns what is wrong with a trimmed TOTP value, a base32 secret
// or an otpauth://totp/ URI, or "".
func checkTOTP(v string) string {
	if !strings.HasPrefix(strings.ToLower(v), "otpauth:") {
		if !validBase32(v) {
			return errTOTPSecret
		}
		return ""
	}
	u, err := url.Parse(v)
	if err != nil || !strings.EqualFold(u.Host, "totp") {
		return "TOTP value must be a base32 secret or an otpauth://totp/ URI"
	}
	// Parameter names are case-insensitive, the first of a repeated one
	// counts and an empty optional one is as good as absent.
	params := map[string]string{}
	for pair := range strings.SplitSeq(u.RawQuery, "&") {
		name, value, _ := strings.Cut(pair, "=")
		name, err1 := url.QueryUnescape(name)
		value, err2 := url.QueryUnescape(value)
		if err1 != nil || err2 != nil {
			return "invalid otpauth URI query"
		}
		name = asciiLower(name)
		if _, seen := params[name]; !seen {
			params[name] = value
		}
	}
	if !validBase32(params["secret"]) {
		return errTOTPSecret
	}
	if a := params["algorithm"]; a != "" && !slices.Contains([]string{"SHA1", "SHA256", "SHA512"}, strings.ToUpper(a)) {
		return "TOTP algorithm must be SHA1, SHA256 or SHA512"
	}
	if d := params["digits"]; d != "" && d != "6" && d != "7" && d != "8" {
		return "TOTP digits must be 6, 7 or 8"
	}
	if p := params["period"]; p != "" {
		n, err := strconv.Atoi(p)
		if strings.TrimLeft(p, "0123456789") != "" || err != nil || n < 1 || n > 300 {
			return "TOTP period must be 1-300 seconds"
		}
	}
	return ""
}
