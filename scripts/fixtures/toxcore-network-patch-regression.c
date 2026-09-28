#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>

#define _Nonnull
#define _Nullable
#define nullptr NULL
#define TOX_INET6_ADDRSTRLEN 128
#define MAX_PACKET_SIZE 256
#define WSA_FLAG_OVERLAPPED 0x01
#define WSA_FLAG_NO_HANDLE_INHERIT 0x80
typedef uintptr_t Socket;
typedef struct IP { const char *text; int family; } IP;
typedef struct IP_Port { IP ip; uint16_t port; } IP_Port;
typedef struct TCP_Client_Connection {
    IP_Port ip_port;
    struct { unsigned char last_packet[MAX_PACKET_SIZE]; int last_packet_length; int last_packet_sent; } con;
} TCP_Client_Connection;
static int parse_ok = 1, forced_write = INT_MIN, write_calls;
static int direct_calls, wsa_calls, seen_family, seen_type, seen_proto, seen_flags;
static Socket socket_result = 123;
static int make_family(int value) { return value + 10; }
static int make_socktype(int value) { return value + 20; }
static int make_proto(int value) { return value + 30; }
static Socket net_socket_from_native(Socket value) { return value; }
static Socket socket(int family, int type, int proto) {
    ++direct_calls; seen_family = family; seen_type = type; seen_proto = proto; return socket_result;
}
static Socket WSASocketW(int family, int type, int proto, void *info, unsigned int group, unsigned int flags) {
    ++wsa_calls; seen_family = family; seen_type = type; seen_proto = proto; seen_flags = (int)flags;
    if (info != NULL || group != 0) return (Socket)-2;
    return socket_result;
}
static int ip_parse_addr(const IP *ip, char *out, size_t size) {
    if (!parse_ok || strlen(ip->text) >= size) return 0;
    strcpy(out, ip->text); return 1;
}
static int net_family_is_ipv6(int family) { return family == 6; }
static int net_family_is_tcp_ipv6(int family) { return family == 66; }
static uint16_t net_ntohs(uint16_t value) { return (uint16_t)((value >> 8) | (value << 8)); }
static int test_snprintf(char *out, size_t size, const char *format, ...) {
    ++write_calls;
    if (forced_write != INT_MIN) return forced_write;
    va_list args; va_start(args, format); int result = vsnprintf(out, size, format, args); va_end(args); return result;
}
#define snprintf test_snprintf
// The test driver extracts these exact function bodies from the selected materialized source.
#include "network-functions-under-test.h"
#undef snprintf

static int failures;
static void result(const char *name, int passed) { printf("%s %s\n", passed ? "PASS" : "FAIL", name); if (!passed) ++failures; }
static TCP_Client_Connection connection(const char *ip, int family, uint16_t port) {
    TCP_Client_Connection value; memset(&value, 0, sizeof(value)); value.ip_port.ip.text = ip;
    value.ip_port.ip.family = family; value.ip_port.port = net_ntohs(port); value.con.last_packet_length = -77; return value;
}
static void request(const char *name, const char *ip, int family, uint16_t port, const char *expected) {
    TCP_Client_Connection value = connection(ip, family, port);
    int ok = proxy_http_generate_connection_request(&value);
    result(name, ok == 1 && strcmp((char *)value.con.last_packet, expected) == 0
        && value.con.last_packet_length == (int)strlen(expected) && value.con.last_packet_sent == 0);
}
static void socket_case(const char *name, int type, Socket expected) {
    direct_calls = wsa_calls = seen_flags = 0; socket_result = expected;
    Socket actual = sys_socket(NULL, 2, type, 6);
#ifdef OS_WIN32
    result(name, actual == expected && wsa_calls == 1 && direct_calls == 0
        && seen_family == 12 && seen_type == type + 20 && seen_proto == 36
        && seen_flags == (WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT));
#else
    result(name, actual == expected && direct_calls == 1 && wsa_calls == 0
        && seen_family == 12 && seen_type == type + 20 && seen_proto == 36);
#endif
}
int main(void) {
    socket_case("socket_udp_noninherit", 2, 123);
    socket_case("socket_tcp_noninherit", 1, 456);
    socket_case("socket_failure_no_fallback", 2, (Socket)-1);
    request("http_ipv4_crlf", "192.0.2.1", 4, 443, "CONNECT 192.0.2.1:443 HTTP/1.1\r\nHost: 192.0.2.1:443\r\n\r\n");
    request("http_ipv6_authority", "2001:db8::1", 6, 443, "CONNECT [2001:db8::1]:443 HTTP/1.1\r\nHost: [2001:db8::1]:443\r\n\r\n");
    request("http_ipv6_tcp_authority", "2001:db8::2", 66, 65535, "CONNECT [2001:db8::2]:65535 HTTP/1.1\r\nHost: [2001:db8::2]:65535\r\n\r\n");
    request("http_zero_port_preserved", "192.0.2.2", 4, 0, "CONNECT 192.0.2.2:0 HTTP/1.1\r\nHost: 192.0.2.2:0\r\n\r\n");
    TCP_Client_Connection value = connection("192.0.2.1", 4, 443);
    parse_ok = 0; write_calls = 0;
    result("invalid_ip_rejected", proxy_http_generate_connection_request(&value) == 0 && write_calls == 0 && value.con.last_packet_length == -77);
    parse_ok = 1;
    forced_write = -1; result("negative_write_rejected", proxy_http_generate_connection_request(&value) == 0 && value.con.last_packet_length == -77);
    forced_write = MAX_PACKET_SIZE; result("equal_capacity_rejected", proxy_http_generate_connection_request(&value) == 0 && value.con.last_packet_length == -77);
    value.con.last_packet_length = -77;
    forced_write = MAX_PACKET_SIZE + 1; result("over_capacity_rejected", proxy_http_generate_connection_request(&value) == 0 && value.con.last_packet_length == -77);
    return failures ? 1 : 0;
}
