#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "toxcore/Messenger.h"
#include "toxcore/net.h"
#include "toxcore/network.h"
#include "toxcore/tox.h"
#include "toxcore/tox_private.h"
#include "toxcore/tox_struct.h"

#define ROUTE_REAL_DEADLINE_MS 15000
#define TEST_REAL_DEADLINE_MS 30000
#define ROUTE_STEP_MS 5
#define ACCELERATED_STEP_MS 100
#define ACCELERATED_SLEEP_MS 2
#define RECOVERY_SCHEDULING_GRACE_MS 2000
#define ROUTER_COUNT 4
#define ANNOUNCEMENT_WARMUP_REAL_MS 8000
#define LOOPBACK_PORT_FROM 38400
#define LOOPBACK_PORT_TO 38431

typedef struct TestClock {
    uint64_t accelerated_offset_ms;
} TestClock;

typedef struct RequestObservation {
    bool received;
    bool sender_matches;
    bool message_matches;
    const uint8_t *expected_sender;
    const uint8_t *expected_message;
    size_t expected_message_length;
} RequestObservation;

static const Network *loopback_base_network;
static Network_Funcs loopback_network_funcs;
static Network loopback_network;
static bool loopback_network_initialized;

static int loopback_bind(void *obj, Socket sock, const IP_Port *addr)
{
    (void)obj;
    if (loopback_base_network == NULL || loopback_base_network->funcs == NULL
            || loopback_base_network->funcs->bind == NULL || !net_family_is_ipv4(addr->ip.family)) {
        return -1;
    }

    IP_Port loopback_addr = *addr;
    loopback_addr.ip.family = net_family_ipv4();
    loopback_addr.ip.ip.v4 = net_get_ip4_loopback();
    return loopback_base_network->funcs->bind(loopback_base_network->obj, sock, &loopback_addr);
}

static bool configure_loopback_network(Tox_System *system)
{
    if (system->ns == NULL || system->ns->funcs == NULL || system->ns->funcs->bind == NULL) {
        return false;
    }
    if (!loopback_network_initialized) {
        loopback_base_network = system->ns;
        loopback_network_funcs = *loopback_base_network->funcs;
        loopback_network_funcs.bind = loopback_bind;
        loopback_network.funcs = &loopback_network_funcs;
        loopback_network.obj = loopback_base_network->obj;
        loopback_network_initialized = true;
    } else if (system->ns != loopback_base_network) {
        return false;
    }
    system->ns = &loopback_network;
    return true;
}

static uint64_t test_clock_now(void *user_data)
{
    const TestClock *clock = (const TestClock *)user_data;
    return (uint64_t)GetTickCount64() + clock->accelerated_offset_ms;
}

static void on_friend_request(
    Tox *tox,
    const Tox_Public_Key public_key,
    const uint8_t message[],
    size_t length,
    void *user_data)
{
    (void)tox;
    RequestObservation *observation = (RequestObservation *)user_data;
    observation->received = true;
    observation->sender_matches = memcmp(public_key, observation->expected_sender, TOX_PUBLIC_KEY_SIZE) == 0;
    observation->message_matches = length == observation->expected_message_length
        && memcmp(message, observation->expected_message, length) == 0;
}

static Tox *new_tox(const uint8_t *savedata, size_t savedata_length, TestClock *clock)
{
    Tox_Err_Options_New options_error;
    Tox_Options *options = tox_options_new(&options_error);
    if (options == NULL || options_error != TOX_ERR_OPTIONS_NEW_OK) {
        return NULL;
    }
    tox_options_set_ipv6_enabled(options, false);
    tox_options_set_local_discovery_enabled(options, false);
    tox_options_set_udp_enabled(options, true);
    tox_options_set_start_port(options, LOOPBACK_PORT_FROM);
    tox_options_set_end_port(options, LOOPBACK_PORT_TO);
    if (savedata != NULL) {
        tox_options_set_savedata_type(options, TOX_SAVEDATA_TYPE_TOX_SAVE);
        if (!tox_options_set_savedata_data(options, savedata, savedata_length)) {
            tox_options_free(options);
            return NULL;
        }
    }

    Tox_System system = tox_default_system();
    if (!configure_loopback_network(&system)) {
        tox_options_free(options);
        return NULL;
    }
    system.mono_time_callback = test_clock_now;
    system.mono_time_user_data = clock;
    Tox_Options_Testing testing = {0};
    testing.operating_system = &system;
    Tox_Err_New new_error;
    Tox_Err_New_Testing testing_error;
    Tox *tox = tox_new_testing(options, &new_error, &testing, &testing_error);
    tox_options_free(options);
    if (new_error != TOX_ERR_NEW_OK || testing_error != TOX_ERR_NEW_TESTING_OK || tox == NULL) {
        return NULL;
    }

    Tox_Err_Get_Port port_error;
    const uint16_t port = tox_self_get_udp_port(tox, &port_error);
    if (port_error != TOX_ERR_GET_PORT_OK || port < LOOPBACK_PORT_FROM || port > LOOPBACK_PORT_TO) {
        tox_kill(tox);
        return NULL;
    }
    return tox;
}

static bool direct_bootstrap(Tox *tox, const Tox *peer)
{
    Tox_Dht_Id dht_id;
    Tox_Err_Get_Port port_error;
    tox_self_get_dht_id(peer, dht_id);
    const uint16_t port = tox_self_get_udp_port(peer, &port_error);
    if (port_error != TOX_ERR_GET_PORT_OK) {
        return false;
    }
    Tox_Err_Bootstrap bootstrap_error;
    const bool result = tox_bootstrap(tox, "127.0.0.1", port, dht_id, &bootstrap_error);
    return result && bootstrap_error == TOX_ERR_BOOTSTRAP_OK;
}

static bool add_route_friend(Tox *tox, const Tox *peer, Tox_Friend_Number *friend_number)
{
    Tox_Public_Key public_key;
    tox_self_get_public_key(peer, public_key);
    Tox_Err_Friend_Add error;
    *friend_number = tox_friend_add_norequest(tox, public_key, &error);
    return error == TOX_ERR_FRIEND_ADD_OK && *friend_number != UINT32_MAX;
}

static bool route_is_connected(const Tox *tox, Tox_Friend_Number friend_number)
{
    return tox_friend_get_connection_status(tox, friend_number, NULL) != TOX_CONNECTION_NONE;
}

static void iterate_network(
    Tox *sender,
    Tox *const routers[],
    size_t router_count,
    TestClock *clock,
    uint64_t advance_ms)
{
    clock->accelerated_offset_ms += advance_ms;
    for (size_t index = 0; index < router_count; ++index) {
        tox_iterate(routers[index], NULL);
    }
    tox_iterate(sender, NULL);
}

static bool wait_for_sender_route(
    Tox *sender,
    Tox_Friend_Number sender_route_friend,
    Tox *const routers[],
    size_t router_count,
    Tox_Friend_Number router_route_friend,
    TestClock *clock)
{
    const ULONGLONG deadline = GetTickCount64() + ROUTE_REAL_DEADLINE_MS;
    while ((!route_is_connected(sender, sender_route_friend) || !route_is_connected(routers[0], router_route_friend))
            && GetTickCount64() < deadline) {
        iterate_network(sender, routers, router_count, clock, 0);
        Sleep(ROUTE_STEP_MS);
    }
    return route_is_connected(sender, sender_route_friend)
        && route_is_connected(routers[0], router_route_friend);
}

static bool wait_for_initial_request_send(
    Tox *sender,
    Tox_Friend_Number route_friend_number,
    Tox_Friend_Number request_friend_number,
    Tox *const routers[],
    size_t router_count,
    TestClock *clock)
{
    const ULONGLONG deadline = GetTickCount64() + ROUTE_REAL_DEADLINE_MS;
    while (sender->m->friendlist[request_friend_number].status == FRIEND_ADDED
            && GetTickCount64() < deadline) {
        iterate_network(sender, routers, router_count, clock, 0);
        if (!route_is_connected(sender, route_friend_number)) {
            return false;
        }
        Sleep(ROUTE_STEP_MS);
    }
    return sender->m->friendlist[request_friend_number].status == FRIEND_REQUESTED;
}

static bool wait_for_recipient_route(
    Tox *sender,
    Tox_Friend_Number sender_route_friend,
    Tox *const routers[],
    size_t router_count,
    Tox_Friend_Number router_route_friend,
    Tox *recipient,
    Tox_Friend_Number recipient_route_friend,
    RequestObservation *observation)
{
    const ULONGLONG deadline = GetTickCount64() + ROUTE_REAL_DEADLINE_MS;
    while ((!route_is_connected(recipient, recipient_route_friend)
            || !route_is_connected(routers[0], router_route_friend))
            && GetTickCount64() < deadline) {
        for (size_t index = 0; index < router_count; ++index) {
            tox_iterate(routers[index], NULL);
        }
        tox_iterate(sender, NULL);
        tox_iterate(recipient, observation);
        if (!route_is_connected(sender, sender_route_friend)) {
            return false;
        }
        Sleep(ROUTE_STEP_MS);
    }
    return route_is_connected(recipient, recipient_route_friend)
        && route_is_connected(routers[0], router_route_friend);
}

static bool warm_recipient_announcement(
    Tox *sender,
    Tox_Friend_Number sender_route_friend,
    Tox *const routers[],
    size_t router_count,
    Tox_Friend_Number router_route_friend,
    Tox *recipient,
    Tox_Friend_Number recipient_route_friend)
{
    const ULONGLONG deadline = GetTickCount64() + ANNOUNCEMENT_WARMUP_REAL_MS;
    while (GetTickCount64() < deadline) {
        for (size_t index = 0; index < router_count; ++index) {
            tox_iterate(routers[index], NULL);
        }
        tox_iterate(sender, NULL);
        tox_iterate(recipient, NULL);
        if (!route_is_connected(sender, sender_route_friend)
                || !route_is_connected(recipient, recipient_route_friend)
                || !route_is_connected(routers[0], router_route_friend)) {
            return false;
        }
        Sleep(ROUTE_STEP_MS);
    }
    return true;
}

int main(void)
{
    static const uint8_t request_message[] = "offline-loopback-request";
    static const uint32_t expected_retry_timeouts[] = {5, 10, 20, 40, 60};
    int result = 1;
    TestClock clock = {0};
    Tox *sender = NULL;
    Tox *routers[ROUTER_COUNT] = {NULL};
    Tox *recipient = new_tox(NULL, 0, &clock);
    uint8_t *recipient_savedata = NULL;
    size_t savedata_length = 0;

    if (recipient == NULL) {
        fprintf(stderr, "FAIL could not create disposable recipient\n");
        goto cleanup;
    }

    Tox_Address recipient_address;
    tox_self_get_address(recipient, recipient_address);
    savedata_length = tox_get_savedata_size(recipient);
    recipient_savedata = (uint8_t *)malloc(savedata_length);
    if (recipient_savedata == NULL) {
        fprintf(stderr, "FAIL could not allocate disposable savedata\n");
        goto cleanup;
    }
    tox_get_savedata(recipient, recipient_savedata);

    for (size_t index = 0; index < ROUTER_COUNT; ++index) {
        routers[index] = new_tox(NULL, 0, &clock);
        if (routers[index] == NULL) {
            fprintf(stderr, "FAIL could not create disposable loopback router %u\n", (unsigned int)index);
            goto cleanup;
        }
    }
    sender = new_tox(NULL, 0, &clock);
    if (sender == NULL) {
        fprintf(stderr, "FAIL could not create disposable sender\n");
        goto cleanup;
    }
    Tox_Address sender_address;
    tox_self_get_address(sender, sender_address);

    Tox_Friend_Number sender_route_friend;
    Tox_Friend_Number router_sender_friend;
    if (!add_route_friend(sender, routers[0], &sender_route_friend)
            || !add_route_friend(routers[0], sender, &router_sender_friend)) {
        fprintf(stderr, "FAIL could not create the disposable sender/router route\n");
        goto cleanup;
    }

    for (size_t left = 0; left < ROUTER_COUNT; ++left) {
        for (size_t right = 0; right < ROUTER_COUNT; ++right) {
            if (left != right && !direct_bootstrap(routers[left], routers[right])) {
                fprintf(stderr, "FAIL disposable router mesh bootstrap was rejected\n");
                goto cleanup;
            }
        }
        if (!direct_bootstrap(sender, routers[left]) || !direct_bootstrap(routers[left], sender)) {
            fprintf(stderr, "FAIL sender/router bootstrap was rejected\n");
            goto cleanup;
        }
    }
    if (!wait_for_sender_route(
            sender,
            sender_route_friend,
            routers,
            ROUTER_COUNT,
            router_sender_friend,
            &clock)) {
        fprintf(stderr, "FAIL sender did not become routable before queuing the offline request\n");
        goto cleanup;
    }

    Tox_Friend_Number initial_recipient_route_friend;
    Tox_Friend_Number router_recipient_friend;
    if (!add_route_friend(recipient, routers[0], &initial_recipient_route_friend)
            || !add_route_friend(routers[0], recipient, &router_recipient_friend)) {
        fprintf(stderr, "FAIL could not create the disposable recipient/router warmup route\n");
        goto cleanup;
    }
    for (size_t index = 0; index < ROUTER_COUNT; ++index) {
        if (!direct_bootstrap(recipient, routers[index]) || !direct_bootstrap(routers[index], recipient)) {
            fprintf(stderr, "FAIL recipient/router announcement bootstrap was rejected\n");
            goto cleanup;
        }
    }
    if (!wait_for_recipient_route(
            sender,
            sender_route_friend,
            routers,
            ROUTER_COUNT,
            router_recipient_friend,
            recipient,
            initial_recipient_route_friend,
            NULL)
            || !warm_recipient_announcement(
                sender,
                sender_route_friend,
                routers,
                ROUTER_COUNT,
                router_recipient_friend,
                recipient,
                initial_recipient_route_friend)) {
        fprintf(stderr, "FAIL disposable recipient did not publish a routable onion announcement\n");
        goto cleanup;
    }
    tox_kill(recipient);
    recipient = NULL;

    Tox_Err_Friend_Add add_error;
    const Tox_Friend_Number friend_number = tox_friend_add(
        sender,
        recipient_address,
        request_message,
        sizeof(request_message) - 1,
        &add_error);
    if (add_error != TOX_ERR_FRIEND_ADD_OK || friend_number == UINT32_MAX) {
        fprintf(stderr, "FAIL could not queue request while recipient was offline\n");
        goto cleanup;
    }
    if (!route_is_connected(sender, sender_route_friend)) {
        fprintf(stderr, "FAIL sender lost its network route before the offline retry window\n");
        goto cleanup;
    }
    if (!wait_for_initial_request_send(
            sender,
            sender_route_friend,
            friend_number,
            routers,
            ROUTER_COUNT,
            &clock)) {
        fprintf(stderr, "FAIL routable sender could not place the first request into the disposable onion route\n");
        goto cleanup;
    }

    uint32_t observed_retry_timeouts[sizeof(expected_retry_timeouts) / sizeof(expected_retry_timeouts[0])] = {0};
    size_t observed_retry_count = 1;
    observed_retry_timeouts[0] = sender->m->friendlist[friend_number].friendrequest_timeout;
    const uint64_t offline_started_at = test_clock_now(&clock);
    const ULONGLONG offline_real_deadline = GetTickCount64() + TEST_REAL_DEADLINE_MS;
    while ((sender->m->friendlist[friend_number].friendrequest_timeout < FRIENDREQUEST_TIMEOUT_MAX
            || sender->m->friendlist[friend_number].status != FRIEND_REQUESTED)
            && GetTickCount64() < offline_real_deadline) {
        iterate_network(sender, routers, ROUTER_COUNT, &clock, ACCELERATED_STEP_MS);
        if (!route_is_connected(sender, sender_route_friend)) {
            fprintf(stderr, "FAIL sender stopped being routable while recipient was absent\n");
            goto cleanup;
        }

        const uint32_t timeout = sender->m->friendlist[friend_number].friendrequest_timeout;
        if (timeout != observed_retry_timeouts[observed_retry_count - 1]) {
            if (observed_retry_count >= sizeof(observed_retry_timeouts) / sizeof(observed_retry_timeouts[0])) {
                fprintf(stderr, "FAIL retry timeout changed more often than the capped schedule allows\n");
                goto cleanup;
            }
            observed_retry_timeouts[observed_retry_count++] = timeout;
        }
        Sleep(ACCELERATED_SLEEP_MS);
    }

    if (observed_retry_count != sizeof(expected_retry_timeouts) / sizeof(expected_retry_timeouts[0])
            || memcmp(observed_retry_timeouts, expected_retry_timeouts, sizeof(expected_retry_timeouts)) != 0) {
        fprintf(stderr, "FAIL live retry timeouts did not follow 5,10,20,40,60 seconds; observed=");
        for (size_t index = 0; index < observed_retry_count; ++index) {
            fprintf(stderr, "%s%u", index == 0 ? "" : ",", (unsigned int)observed_retry_timeouts[index]);
        }
        fprintf(
            stderr,
            " status=%u virtual_elapsed_ms=%llu\n",
            (unsigned int)sender->m->friendlist[friend_number].status,
            (unsigned long long)(test_clock_now(&clock) - offline_started_at));
        goto cleanup;
    }
    const Friend *sender_friend = &sender->m->friendlist[friend_number];
    if (sender_friend->friendrequest_timeout > 60 || sender_friend->status != FRIEND_REQUESTED) {
        fprintf(stderr, "FAIL live friend request did not enter the capped 60-second retry interval\n");
        goto cleanup;
    }
    const uint64_t offline_elapsed = test_clock_now(&clock) - offline_started_at;
    if (offline_elapsed < UINT64_C(75000)) {
        fprintf(stderr, "FAIL recipient absence did not span all pre-cap backoff intervals\n");
        goto cleanup;
    }

    // Recreate the recipient only after the sender has stayed routable through
    // 5, 10, 20 and 40-second failed attempts and has entered the 60-second
    // capped interval. Savedata stays in memory and never touches a profile.
    const uint64_t capped_request_sent_at = test_clock_now(&clock);
    const uint64_t accelerated_offset = clock.accelerated_offset_ms;
    clock.accelerated_offset_ms = 0;
    recipient = new_tox(recipient_savedata, savedata_length, &clock);
    clock.accelerated_offset_ms = accelerated_offset;
    if (recipient == NULL) {
        fprintf(stderr, "FAIL could not restore disposable recipient\n");
        goto cleanup;
    }
    Tox_Address restored_address;
    tox_self_get_address(recipient, restored_address);
    if (memcmp(recipient_address, restored_address, TOX_ADDRESS_SIZE) != 0) {
        fprintf(stderr, "FAIL recipient identity changed after disposable restore\n");
        goto cleanup;
    }

    RequestObservation observation = {
        false,
        false,
        false,
        sender_address,
        request_message,
        sizeof(request_message) - 1,
    };
    tox_callback_friend_request(recipient, on_friend_request);
    Tox_Friend_Number recipient_route_friend;
    if (!add_route_friend(recipient, routers[0], &recipient_route_friend)) {
        fprintf(stderr, "FAIL could not create the disposable recipient/router route\n");
        goto cleanup;
    }
    for (size_t index = 0; index < ROUTER_COUNT; ++index) {
        if (!direct_bootstrap(recipient, routers[index]) || !direct_bootstrap(routers[index], recipient)) {
            fprintf(stderr, "FAIL restored recipient/router bootstrap was rejected\n");
            goto cleanup;
        }
    }
    if (!wait_for_recipient_route(
            sender,
            sender_route_friend,
            routers,
            ROUTER_COUNT,
            router_recipient_friend,
            recipient,
            recipient_route_friend,
            &observation)) {
        fprintf(stderr, "FAIL restored recipient did not become routable over the disposable router\n");
        goto cleanup;
    }

    const uint64_t virtual_recovery_deadline = capped_request_sent_at
        + (uint64_t)FRIENDREQUEST_TIMEOUT_MAX * UINT64_C(1000)
        + RECOVERY_SCHEDULING_GRACE_MS;
    const ULONGLONG recovery_real_deadline = GetTickCount64() + TEST_REAL_DEADLINE_MS;
    while (!observation.received
            && test_clock_now(&clock) <= virtual_recovery_deadline
            && GetTickCount64() < recovery_real_deadline) {
        clock.accelerated_offset_ms += ACCELERATED_STEP_MS;
        for (size_t index = 0; index < ROUTER_COUNT; ++index) {
            tox_iterate(routers[index], NULL);
        }
        tox_iterate(sender, NULL);
        tox_iterate(recipient, &observation);
        if (!route_is_connected(sender, sender_route_friend)) {
            fprintf(stderr, "FAIL sender lost routability while waiting for the capped retry\n");
            goto cleanup;
        }
        Sleep(ACCELERATED_SLEEP_MS);
    }

    if (!observation.received) {
        fprintf(stderr, "FAIL offline request was not delivered within the 60-second cap plus scheduler grace\n");
        goto cleanup;
    }
    if (!observation.sender_matches || !observation.message_matches) {
        fprintf(stderr, "FAIL delivered request identity or message did not match\n");
        goto cleanup;
    }

    const uint64_t recovery_elapsed = test_clock_now(&clock) - capped_request_sent_at;
    printf(
        "PASS sender stayed routable for %llu virtual ms; retry timeouts 5,10,20,40,60 seconds\n",
        (unsigned long long)offline_elapsed);
    printf(
        "PASS offline friend request delivered %llu virtual ms after recipient restore (cap=%u seconds)\n",
        (unsigned long long)recovery_elapsed,
        (unsigned int)FRIENDREQUEST_TIMEOUT_MAX);
    result = 0;

cleanup:
    if (recipient != NULL) {
        tox_kill(recipient);
    }
    if (sender != NULL) {
        tox_kill(sender);
    }
    for (size_t index = 0; index < ROUTER_COUNT; ++index) {
        if (routers[index] != NULL) {
            tox_kill(routers[index]);
        }
    }
    if (recipient_savedata != NULL) {
        SecureZeroMemory(recipient_savedata, savedata_length);
        free(recipient_savedata);
    }
    return result;
}
