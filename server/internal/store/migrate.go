package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SchemaVersion is the schema this build migrates databases to. It is stored
// in PRAGMA user_version; databases created before migrations existed are
// version 0 (the schema constant).
//
// Migrations only add tables, columns and indexes and never rewrite or delete
// existing rows, so an older build can still open a migrated database (deploy
// rollbacks rely on this).
const SchemaVersion = 1

// migrations[i] upgrades the schema from version i to i+1.
var migrations = []func(ctx context.Context, tx *sql.Tx) error{
	migrateV1,
}

// Migration describes what Open did to the schema.
type Migration struct {
	From, To int
	// Snapshot is the path of the copy taken before migrating an existing
	// database, or "" when nothing was migrated or the database was new.
	Snapshot string
}

// migrate brings the schema up to SchemaVersion. existed reports whether the
// database already held the users table before Open created the base schema;
// such a database is copied with VACUUM INTO before it is changed.
func (s *Store) migrate(ctx context.Context, path string, existed bool, now time.Time) (Migration, error) {
	var version int
	if err := s.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return Migration{}, err
	}
	m := Migration{From: version, To: version}
	if version > SchemaVersion {
		// A newer build migrated this database. Its migrations are additive,
		// so this build can keep working with the columns it knows.
		log.Printf("database schema version %d is newer than this build (%d)", version, SchemaVersion)
		return m, nil
	}
	if version == SchemaVersion {
		return m, nil
	}
	// A logical backup (sqlite3 .dump) does not keep user_version: a
	// database restored from one has the schema 1 objects at version 0.
	if version == 0 {
		shaped, err := hasSchemaV1(ctx, s.db)
		if err != nil {
			return m, err
		}
		if shaped {
			if _, err := s.db.ExecContext(ctx, `PRAGMA user_version = 1`); err != nil {
				return m, err
			}
			log.Printf("database has the schema 1 tables at version 0 (restored from a logical backup?); set its version to 1")
			version, m.From = 1, 1
		}
	}
	if version == SchemaVersion {
		m.To = version
		return m, nil
	}
	// Refuse a database the migrations cannot take before copying it: a
	// restart loop would otherwise add a full copy on every attempt.
	if version < 1 {
		if err := checkUniqueCredentialIDs(ctx, s.db); err != nil {
			return m, fmt.Errorf("migrate schema 0 to 1: %w", err)
		}
	}
	if existed {
		snapshot := snapshotPath(path, SchemaVersion, now)
		if _, err := s.db.ExecContext(ctx, `VACUUM INTO `+sqlString(snapshot)); err != nil {
			return m, fmt.Errorf("snapshot database before migrating to schema %d: %w", SchemaVersion, err)
		}
		// The copy holds every private key: keep it as private as the database.
		if fi, err := os.Stat(path); err == nil {
			if err := os.Chmod(snapshot, fi.Mode().Perm()); err != nil {
				return m, err
			}
		}
		m.Snapshot = snapshot
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return m, err
	}
	defer tx.Rollback()
	for v := version; v < SchemaVersion; v++ {
		if err := migrations[v](ctx, tx); err != nil {
			return m, fmt.Errorf("migrate schema %d to %d: %w", v, v+1, err)
		}
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf(`PRAGMA user_version = %d`, SchemaVersion)); err != nil {
		return m, err
	}
	if err := tx.Commit(); err != nil {
		return m, err
	}
	m.To = SchemaVersion
	return m, nil
}

// snapshotPath names the pre-migration copy next to the database, for example
// data/passkey-box.pre-v1-20261123T010203Z.db.
func snapshotPath(path string, version int, now time.Time) string {
	ext := filepath.Ext(path)
	return fmt.Sprintf("%s.pre-v%d-%s%s", strings.TrimSuffix(path, ext), version, now.UTC().Format("20060102T150405Z"), ext)
}

func sqlString(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// hasSchemaV1 reports whether the schema 1 objects exist. Some but not all of
// them is an error: no migration leaves a database like that.
func hasSchemaV1(ctx context.Context, q queryer) (bool, error) {
	var objects, columns int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master
		WHERE name IN ('credential_shares', 'api_tokens', 'audit_log', 'credentials_id')`).Scan(&objects); err != nil {
		return false, err
	}
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('users')
		WHERE name IN ('disabled', 'note')`).Scan(&columns); err != nil {
		return false, err
	}
	switch {
	case objects == 4 && columns == 2:
		return true, nil
	case objects == 0 && columns == 0:
		return false, nil
	}
	return false, fmt.Errorf("database has only part of schema 1; restore it from a complete backup")
}

// checkUniqueCredentialIDs reports a credential ID stored for more than one
// user, which schema 0 allowed and schema 1 does not.
func checkUniqueCredentialIDs(ctx context.Context, q queryer) error {
	var dup string
	err := q.QueryRowContext(ctx, `SELECT id FROM credentials GROUP BY id HAVING COUNT(*) > 1 LIMIT 1`).Scan(&dup)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("credential id %q is stored more than once; delete all but one of them before upgrading", dup)
}

// migrateV1 adds credential sharing, API tokens, the audit log and the user
// status and note columns, and makes credential IDs unique across users.
func migrateV1(ctx context.Context, tx *sql.Tx) error {
	if err := checkUniqueCredentialIDs(ctx, tx); err != nil {
		return err
	}
	for _, stmt := range []string{
		`ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT ''`,
		`CREATE UNIQUE INDEX credentials_id ON credentials(id)`,
		`CREATE TABLE credential_shares (
			credential_seq INTEGER NOT NULL REFERENCES credentials(seq) ON DELETE CASCADE,
			user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			shared_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
			created_at     INTEGER NOT NULL,
			last_used_at   INTEGER,
			PRIMARY KEY (credential_seq, user_id)
		)`,
		`CREATE INDEX credential_shares_user ON credential_shares(user_id)`,
		`CREATE TABLE api_tokens (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name         TEXT    NOT NULL,
			token_hash   TEXT    NOT NULL UNIQUE,
			prefix       TEXT    NOT NULL,
			read_only    INTEGER NOT NULL DEFAULT 0,
			created_at   INTEGER NOT NULL,
			expires_at   INTEGER,
			last_used_at INTEGER
		)`,
		`CREATE INDEX api_tokens_user ON api_tokens(user_id)`,
		// Audit rows keep the IDs and names of the users involved as plain
		// values, so the history survives when users are deleted.
		`CREATE TABLE audit_log (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			at            INTEGER NOT NULL,
			actor_id      INTEGER,
			actor_name    TEXT    NOT NULL DEFAULT '',
			via           TEXT    NOT NULL DEFAULT '',
			action        TEXT    NOT NULL,
			subject_id    INTEGER,
			subject_name  TEXT    NOT NULL DEFAULT '',
			target_id     INTEGER,
			target_name   TEXT    NOT NULL DEFAULT '',
			credential_id TEXT    NOT NULL DEFAULT '',
			rp_id         TEXT    NOT NULL DEFAULT '',
			account       TEXT    NOT NULL DEFAULT '',
			detail        TEXT    NOT NULL DEFAULT '{}'
		)`,
		`CREATE INDEX audit_log_actor ON audit_log(actor_id, id)`,
		`CREATE INDEX audit_log_subject ON audit_log(subject_id, id)`,
		`CREATE INDEX audit_log_target ON audit_log(target_id, id)`,
		`CREATE INDEX audit_log_credential ON audit_log(credential_id, id)`,
	} {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}
