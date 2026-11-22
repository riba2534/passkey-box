package store

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// counterIDs returns an ID generator that yields the given IDs, then id1, id2...
func counterIDs(ids ...string) func() string {
	n := 0
	return func() string {
		n++
		if n <= len(ids) {
			return ids[n-1]
		}
		return fmt.Sprintf("id%d", n)
	}
}

// fieldError returns the message normalizeFields refuses fields with, or "".
func fieldError(t *testing.T, fields ...Field) string {
	t.Helper()
	_, err := normalizeFields(fields, counterIDs())
	if err == nil {
		return ""
	}
	var inv *InvalidError
	if !errors.As(err, &inv) {
		t.Fatalf("error %v is not an *InvalidError", err)
	}
	return inv.Reason
}

func TestFieldTypesAndLengths(t *testing.T) {
	ok := Field{Type: "text"}
	for _, typ := range FieldTypes {
		value := "x"
		switch typ {
		case "date":
			value = "2026-11-23"
		case "totp":
			value = "JBSWY3DPEHPK3PXP"
		}
		if msg := fieldError(t, ok, Field{Type: typ, Value: value}); msg != "" {
			t.Errorf("type %s: %s", typ, msg)
		}
	}
	for _, typ := range []string{"", "Text", "TOTP", "note", "hidden", " text"} {
		if msg := fieldError(t, ok, Field{Type: typ}); !strings.HasPrefix(msg, "fields[1]: type must be one of text, password") {
			t.Errorf("type %q: %q", typ, msg)
		}
	}
	for name, tc := range map[string]struct {
		f    Field
		want string
	}{
		"label at the limit":        {Field{Type: "text", Label: strings.Repeat("标", MaxFieldLabelLen)}, ""},
		"label over the limit":      {Field{Type: "text", Label: strings.Repeat("a", MaxFieldLabelLen+1)}, "fields[1]: label must be at most 100 characters"},
		"label trimmed to fit":      {Field{Type: "text", Label: " \t" + strings.Repeat("a", MaxFieldLabelLen) + "\n "}, ""},
		"value at the limit":        {Field{Type: "multiline", Value: strings.Repeat("值", MaxFieldValueLen)}, ""},
		"value over the limit":      {Field{Type: "password", Value: strings.Repeat("a", MaxFieldValueLen+1)}, "fields[1]: value must be at most 10000 characters"},
		"untrimmed value counts":    {Field{Type: "text", Value: " " + strings.Repeat("a", MaxFieldValueLen)}, "fields[1]: value must be at most 10000 characters"},
		"long date":                 {Field{Type: "date", Value: strings.Repeat("1", MaxFieldValueLen+1)}, "fields[1]: value must be at most 10000 characters"},
		"empty value":               {Field{Type: "url"}, ""},
		"any text in a url field":   {Field{Type: "url", Value: "javascript:alert(1)"}, ""},
		"any text in an email":      {Field{Type: "email", Value: "not an address"}, ""},
		"any text in a phone field": {Field{Type: "phone", Value: "call me"}, ""},
	} {
		if got := fieldError(t, ok, tc.f); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}

	max := make([]Field, MaxFields+1)
	for i := range max {
		max[i] = Field{Type: "text"}
	}
	if msg := fieldError(t, max[:MaxFields]...); msg != "" {
		t.Fatalf("%d fields: %s", MaxFields, msg)
	}
	if msg := fieldError(t, max...); msg != "fields[50]: at most 50 fields are allowed" {
		t.Fatalf("%d fields: %q", MaxFields+1, msg)
	}
	if got, err := normalizeFields(nil, counterIDs()); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("no fields = %#v, %v", got, err)
	}
}

func TestDateFields(t *testing.T) {
	for _, v := range []string{"", "2026-11-23", "2024-02-29", "0001-01-01", "9999-12-31", " 2026-01-01\n"} {
		if msg := fieldError(t, Field{Type: "date", Value: v}); msg != "" {
			t.Errorf("date %q: %s", v, msg)
		}
	}
	for _, v := range []string{"2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-1-05", "2026-01-5",
		"20260105", "2026/01/05", "+202-01-01", "2026-01-05T00:00:00Z", "26-01-05", "today"} {
		if msg := fieldError(t, Field{Type: "date", Value: v}); msg != "fields[0]: date must be a valid date in YYYY-MM-DD form" {
			t.Errorf("date %q: %q", v, msg)
		}
	}
	got, err := normalizeFields([]Field{{Type: "date", Value: " 2026-01-01 "}, {Type: "text", Label: " 备注 ", Value: " 原样 "}}, counterIDs())
	if err != nil || got[0].Value != "2026-01-01" || got[1].Label != "备注" || got[1].Value != " 原样 " {
		t.Fatalf("trimmed = %+v, %v", got, err)
	}
}

func TestBase32Secrets(t *testing.T) {
	for _, s := range []string{
		"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", // RFC 6238
		"JBSWY3DPEHPK3PXP",
		"jbswy3dpehpk3pxp",
		"jbsw y3dp-ehpk 3pxp",
		"JBSW\tY3DP\nEHPK Y3DP",
		"GE",
		"GE======",
		"GE=",
		"GEZDG",
		"GEZDGNB",
		"GEZDGNBVGEZDGNB=",
		"MFRGG===",
	} {
		if !validBase32(s) {
			t.Errorf("%q is a valid secret", s)
		}
	}
	for _, s := range []string{
		"",
		"   ",
		"-",
		"====",
		"G",           // length 1 mod 8
		"GEZ",         // 3 mod 8: Go would decode no byte without an error
		"GEZDGN",      // 6 mod 8
		"GEZDGNBVGEZ", // 11 = 3 mod 8
		"GE=ZDG",      // = inside
		"=GE",
		"GEZDGNBV1",
		"GEZDGNB8",
		"GEZDGNBÄ",
		"GE ZD/GN",
		"otpauth:",
	} {
		if validBase32(s) {
			t.Errorf("%q is not a valid secret", s)
		}
	}
}

func TestTOTPFields(t *testing.T) {
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	for _, v := range []string{
		secret,
		"  gezd gnbv-gy3t qojq  ",
		"otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example",
		"otpauth://totp/ACME%20Co:john?secret=" + secret + "&issuer=ACME&algorithm=SHA256&digits=8&period=60",
		"OTPAUTH://TOTP/x?SECRET=jbswy3dpehpk3pxp&Algorithm=sha512&DIGITS=7&Period=300",
		"otpauth://totp/ACME Co:john?secret=JBSWY3DPEHPK3PXP",
		"otpauth://totp?secret=JBSWY3DPEHPK3PXP",
		"otpauth://totp/?secret=JBSW+Y3DP-EHPK%20 3PXP",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=&digits=&period=",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=1&digits=6&algorithm=SHA1",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=030",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&image=https://x/y.png&counter=3",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP#fragment",
		// The first of a repeated parameter counts.
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&secret=GEZ&digits=8&DIGITS=5",
		"otpauth://totp/x?algorithm=&algorithm=MD5&secret=JBSWY3DPEHPK3PXP",
		"\n otpauth://totp/x?secret=JBSWY3DPEHPK3PXP \t",
	} {
		if msg := fieldError(t, Field{Type: "totp", Value: v}); msg != "" {
			t.Errorf("%q: %s", v, msg)
		}
	}
	for v, want := range map[string]string{
		"":                            "invalid TOTP secret",
		"GEZ":                         "invalid TOTP secret",
		"GEZDGNBVGEZ":                 "invalid TOTP secret",
		"JBSW=Y3DP":                   "invalid TOTP secret",
		"123456":                      "invalid TOTP secret",
		"otpauth://totp/x":            "invalid TOTP secret",
		"otpauth://totp/x?":           "invalid TOTP secret",
		"otpauth://totp/x?secret=":    "invalid TOTP secret",
		"otpauth://totp/x?secret=GEZ": "invalid TOTP secret",
		"otpauth://totp/x?secret=&secret=JBSWY3DPEHPK3PXP":                     "invalid TOTP secret",
		"otpauth://totp/x?issuer=JBSWY3DPEHPK3PXP":                             "invalid TOTP secret",
		"otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1":                   "TOTP value must be a base32 secret or an otpauth://totp/ URI",
		"otpauth:totp?secret=JBSWY3DPEHPK3PXP":                                 "TOTP value must be a base32 secret or an otpauth://totp/ URI",
		"otpauth://totp.example/x?secret=JBSWY3DPEHPK3PXP":                     "TOTP value must be a base32 secret or an otpauth://totp/ URI",
		"otpauth://totp:80/x?secret=JBSWY3DPEHPK3PXP":                          "TOTP value must be a base32 secret or an otpauth://totp/ URI",
		"otpauth://totp/a%zz?secret=JBSWY3DPEHPK3PXP":                          "TOTP value must be a base32 secret or an otpauth://totp/ URI",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=%zz":                  "invalid otpauth URI query",
		"https://totp/x?secret=JBSWY3DPEHPK3PXP":                               "invalid TOTP secret",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5":               "TOTP algorithm must be SHA1, SHA256 or SHA512",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA-1":             "TOTP algorithm must be SHA1, SHA256 or SHA512",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=5":                    "TOTP digits must be 6, 7 or 8",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9":                    "TOTP digits must be 6, 7 or 8",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=06":                   "TOTP digits must be 6, 7 or 8",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=six":                  "TOTP digits must be 6, 7 or 8",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0":                    "TOTP period must be 1-300 seconds",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=301":                  "TOTP period must be 1-300 seconds",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=-30":                  "TOTP period must be 1-300 seconds",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=%2B30":                "TOTP period must be 1-300 seconds",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=30s":                  "TOTP period must be 1-300 seconds",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=1.5":                  "TOTP period must be 1-300 seconds",
		"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=99999999999999999999": "TOTP period must be 1-300 seconds",
	} {
		if msg := fieldError(t, Field{Type: "text"}, Field{Type: "totp", Value: v}); msg != "fields[1]: "+want {
			t.Errorf("%q: %q, want %q", v, msg, want)
		}
	}
	got, err := normalizeFields([]Field{{Type: "totp", Value: "  otpauth://totp/x?secret=JBSWY3DPEHPK3PXP\n"},
		{Type: "totp", Value: " jbsw y3dp "}}, counterIDs())
	if err != nil || got[0].Value != "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" || got[1].Value != "jbsw y3dp" {
		t.Fatalf("stored TOTP values = %+v, %v", got, err)
	}
}

func TestFieldIDs(t *testing.T) {
	long := strings.Repeat("a", 32)
	got, err := normalizeFields([]Field{
		{ID: "keep_1-A", Type: "text"},
		{Type: "text"},                 // none
		{ID: "bad id", Type: "text"},   // malformed
		{ID: "keep_1-A", Type: "text"}, // repeated
		{ID: long, Type: "text"},       // longest
		{ID: long + "a", Type: "text"}, // too long
		{ID: "id1", Type: "text"},      // looks like a generated one
		{ID: "Xk3pQ9aB", Type: "password"},
	}, counterIDs("id1", "keep_1-A", "id1", "fresh1", long, "fresh2", "fresh3", "fresh4"))
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, f := range got {
		ids = append(ids, f.ID)
	}
	// Generated IDs never repeat a kept one or each other.
	if want := []string{"keep_1-A", "fresh1", "fresh2", "fresh3", long, "fresh4", "id1", "Xk3pQ9aB"}; !slices.Equal(ids, want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
	if got[7].Type != "password" {
		t.Fatalf("fields moved: %+v", got)
	}

	pattern := regexp.MustCompile(`^[A-Za-z0-9_-]{8}$`)
	seen := map[string]bool{}
	for range 1000 {
		id := newFieldID()
		if !pattern.MatchString(id) || seen[id] {
			t.Fatalf("new field ID %q (seen %v)", id, seen[id])
		}
		seen[id] = true
	}
}
