#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sqlite3.h"

typedef struct FormatCase {
    const char *label;
    const char *filename;
    const char *settings;
} FormatCase;

typedef struct TextCapture {
    char value[160];
    int rows;
} TextCapture;

static const char *const correct_key =
    "PRAGMA key=\"x'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'\";";
static const char *const wrong_key =
    "PRAGMA key=\"x'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'\";";

static int capture_text(void *context, int columns, char **values, char **names)
{
    (void)names;
    TextCapture *capture = (TextCapture *)context;
    if (columns > 0 && values != NULL && values[0] != NULL) {
        strncpy_s(capture->value, sizeof(capture->value), values[0], _TRUNCATE);
    }
    capture->rows += 1;
    return 0;
}

static int exec_sql(sqlite3 *database, const char *sql, const char *operation)
{
    const int result = sqlite3_exec(database, sql, NULL, NULL, NULL);
    if (result != SQLITE_OK) {
        fprintf(stderr, "FAIL %s: %s (%d)\n", operation, sqlite3_errmsg(database), result);
    }
    return result;
}

static int exec_text(sqlite3 *database, const char *sql, TextCapture *capture, const char *operation)
{
    memset(capture, 0, sizeof(*capture));
    const int result = sqlite3_exec(database, sql, capture_text, capture, NULL);
    if (result != SQLITE_OK) {
        fprintf(stderr, "FAIL %s: %s (%d)\n", operation, sqlite3_errmsg(database), result);
    }
    return result;
}

static int apply_key(sqlite3 *database, const char *key, const char *settings)
{
    char sql[640];
    if (sprintf_s(sql, sizeof(sql), "%s %s PRAGMA cipher_log_level=NONE;", key, settings) < 0) {
        return SQLITE_ERROR;
    }
    return exec_sql(database, sql, "apply SQLCipher key/settings");
}

static int encrypted_header(const char *path)
{
    static const unsigned char sqlite_header[] = "SQLite format 3";
    unsigned char header[16] = {0};
    FILE *file = NULL;
    if (fopen_s(&file, path, "rb") != 0 || file == NULL) {
        fprintf(stderr, "FAIL could not read encrypted database\n");
        return 0;
    }
    const size_t read = fread(header, 1, sizeof(header), file);
    fclose(file);
    if (read != sizeof(header)) {
        fprintf(stderr, "FAIL encrypted database header is truncated\n");
        return 0;
    }
    if (memcmp(header, sqlite_header, sizeof(sqlite_header) - 1) == 0) {
        fprintf(stderr, "FAIL database retained a plaintext SQLite header\n");
        return 0;
    }
    return 1;
}

static int path_is_available(const char *path)
{
    FILE *existing = NULL;
    if (fopen_s(&existing, path, "rb") == 0 && existing != NULL) {
        fclose(existing);
        fprintf(stderr, "FAIL refusing to overwrite existing synthetic database: %s\n", path);
        return 0;
    }
    return 1;
}

static int validate_qtox_query(sqlite3 *database)
{
    static const char query[] =
        "SELECT history.id, history.timestamp, chats.uuid, authors.public_key, "
        "text_messages.message, file_transfers.file_name, file_transfers.file_path, "
        "file_transfers.file_size FROM history JOIN chats ON history.chat_id=chats.id "
        "LEFT JOIN text_messages ON history.id=text_messages.id "
        "LEFT JOIN file_transfers ON history.id=file_transfers.id "
        "LEFT JOIN aliases ON text_messages.sender_alias=aliases.id "
        "OR file_transfers.sender_alias=aliases.id "
        "LEFT JOIN authors ON aliases.owner=authors.id "
        "WHERE history.message_type IN ('T','F') ORDER BY history.timestamp, history.id;";
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(database, query, -1, &statement, NULL) != SQLITE_OK || statement == NULL) {
        fprintf(stderr, "FAIL prepare qTox import query: %s\n", sqlite3_errmsg(database));
        return 0;
    }
    int ok = 1;
    if (sqlite3_step(statement) != SQLITE_ROW) {
        fprintf(stderr, "FAIL qTox import query did not return the synthetic row\n");
        ok = 0;
    } else {
        const unsigned char *text = sqlite3_column_text(statement, 4);
        ok = sqlite3_column_int64(statement, 0) == 42
            && sqlite3_column_int64(statement, 1) == 1700000000000LL
            && sqlite3_column_bytes(statement, 2) == 32
            && sqlite3_column_blob(statement, 2) != NULL
            && sqlite3_column_bytes(statement, 3) == 32
            && sqlite3_column_blob(statement, 3) != NULL
            && text != NULL
            && strcmp((const char *)text, "synthetic qTox history") == 0
            && sqlite3_column_type(statement, 5) == SQLITE_NULL;
        if (!ok) {
            fprintf(stderr, "FAIL qTox import query returned incompatible column values\n");
        }
    }
    if (ok && sqlite3_step(statement) != SQLITE_DONE) {
        fprintf(stderr, "FAIL qTox import query returned unexpected extra rows\n");
        ok = 0;
    }
    if (sqlite3_finalize(statement) != SQLITE_OK) {
        fprintf(stderr, "FAIL finalize qTox import query\n");
        ok = 0;
    }
    return ok;
}

static int create_and_verify(const char *directory, const FormatCase *format, int report_versions)
{
    static const char schema[] =
        "CREATE TABLE chats(id INTEGER PRIMARY KEY, uuid BLOB NOT NULL);"
        "CREATE TABLE authors(id INTEGER PRIMARY KEY, public_key BLOB NOT NULL);"
        "CREATE TABLE aliases(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL);"
        "CREATE TABLE history(id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, "
        "chat_id INTEGER NOT NULL, message_type TEXT NOT NULL);"
        "CREATE TABLE text_messages(id INTEGER PRIMARY KEY, message TEXT, sender_alias INTEGER);"
        "CREATE TABLE file_transfers(id INTEGER PRIMARY KEY, file_name TEXT, file_path TEXT, "
        "file_size INTEGER, sender_alias INTEGER);"
        "INSERT INTO chats VALUES(1, X'000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F');"
        "INSERT INTO authors VALUES(1, X'202122232425262728292A2B2C2D2E2F303132333435363738393A3B3C3D3E3F');"
        "INSERT INTO aliases VALUES(1, 1);"
        "INSERT INTO history VALUES(42, 1700000000000, 1, 'T');"
        "INSERT INTO text_messages VALUES(42, 'synthetic qTox history', 1);";
    char path[1024];
    if (sprintf_s(path, sizeof(path), "%s\\%s", directory, format->filename) < 0) {
        fprintf(stderr, "FAIL synthetic database path is too long\n");
        return 0;
    }
    if (!path_is_available(path)) {
        return 0;
    }

    sqlite3 *database = NULL;
    if (sqlite3_open_v2(path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK
        || database == NULL) {
        fprintf(stderr, "FAIL create %s fixture\n", format->label);
        if (database != NULL) {
            sqlite3_close(database);
        }
        return 0;
    }
    if (apply_key(database, correct_key, format->settings) != SQLITE_OK
        || exec_sql(database, schema, "create synthetic qTox schema") != SQLITE_OK
        || sqlite3_close(database) != SQLITE_OK) {
        return 0;
    }
    database = NULL;
    if (!encrypted_header(path)) {
        return 0;
    }

    if (sqlite3_open_v2(path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK
        || database == NULL) {
        fprintf(stderr, "FAIL reopen %s fixture with wrong key\n", format->label);
        return 0;
    }
    if (apply_key(database, wrong_key, format->settings) != SQLITE_OK) {
        sqlite3_close(database);
        return 0;
    }
    if (sqlite3_exec(database, "SELECT count(*) FROM sqlite_master;", NULL, NULL, NULL) == SQLITE_OK) {
        fprintf(stderr, "FAIL %s fixture opened with the wrong key\n", format->label);
        sqlite3_close(database);
        return 0;
    }
    sqlite3_close(database);
    database = NULL;
    printf("PASS %s wrong-key rejection\n", format->label);

    if (sqlite3_open_v2(path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK
        || database == NULL) {
        fprintf(stderr, "FAIL reopen %s fixture with correct key\n", format->label);
        return 0;
    }
    if (apply_key(database, correct_key, format->settings) != SQLITE_OK
        || exec_sql(database, "SELECT count(*) FROM sqlite_master;", "decrypt synthetic qTox database") != SQLITE_OK
        || !validate_qtox_query(database)) {
        sqlite3_close(database);
        return 0;
    }

    if (report_versions) {
        TextCapture cipher = {{0}, 0};
        TextCapture provider = {{0}, 0};
        TextCapture provider_version = {{0}, 0};
        if (exec_text(database, "PRAGMA cipher_version;", &cipher, "query SQLCipher version") != SQLITE_OK
            || exec_text(database, "PRAGMA cipher_provider;", &provider, "query SQLCipher provider") != SQLITE_OK
            || exec_text(database, "PRAGMA cipher_provider_version;", &provider_version, "query provider version") != SQLITE_OK
            || cipher.rows != 1 || strncmp(cipher.value, "4.17.0", 6) != 0
            || provider.rows != 1 || strcmp(provider.value, "openssl") != 0
            || provider_version.rows != 1 || strstr(provider_version.value, "3.5.7") == NULL
            || strcmp(sqlite3_libversion(), "3.53.3") != 0) {
            fprintf(stderr, "FAIL linked component versions do not match the requested sources\n");
            sqlite3_close(database);
            return 0;
        }
        printf("VERSIONS SQLCipher=%s SQLite=%s provider=%s provider_version=%s\n",
            cipher.value, sqlite3_libversion(), provider.value, provider_version.value);
    }

    sqlite3_close(database);
    printf("PASS %s encrypted qTox-schema round trip\n", format->label);
    return 1;
}

int main(int argc, char **argv)
{
    static const FormatCase formats[] = {
        {
            "qTox/SQLCipher-4 SHA-512",
            "qtox-v4-sha512.db",
            "PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; "
            "PRAGMA cipher_hmac_algorithm=HMAC_SHA512; "
            "PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512;",
        },
        {
            "qTox compatibility SHA-1/4096",
            "qtox-sha1-4096.db",
            "PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; "
            "PRAGMA cipher_hmac_algorithm=HMAC_SHA1; "
            "PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA1;",
        },
        {
            "legacy SQLCipher-3 SHA-1/1024",
            "qtox-v3-sha1-1024.db",
            "PRAGMA cipher_page_size=1024; PRAGMA kdf_iter=64000; "
            "PRAGMA cipher_hmac_algorithm=HMAC_SHA1; "
            "PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA1;",
        },
    };
    if (argc != 2) {
        fprintf(stderr, "usage: sqlcipher_smoke.exe OUTPUT_DIRECTORY\n");
        return 2;
    }
    for (size_t index = 0; index < sizeof(formats) / sizeof(formats[0]); ++index) {
        if (!create_and_verify(argv[1], &formats[index], index == 0)) {
            return 1;
        }
    }
    puts("PASS SQLCipher runtime smoke complete");
    return 0;
}
