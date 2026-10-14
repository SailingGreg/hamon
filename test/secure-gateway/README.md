# KNXnet/IP Secure gateway simulator

A stand-alone simulator of the gateway side of **KNXnet/IP Secure tunnelling**
(over TCP), with optional **KNX Data Secure** group telegrams. It's for testing
and debugging secure clients without a real secure gateway. It's optional:
nothing in hamon depends on it, and it has its own setup.

It plays the gateway's part of the exchange:

- secure session set-up: X25519 key exchange, the SESSION_RESPONSE MAC with the
  device authentication code, and the user check (SESSION_AUTHENTICATE)
- tunnelling inside SECURE_WRAPPERs: connect, connection state, disconnect,
  and an L_Data.con back for each L_Data.req
- scripted group telegrams to the client: plain, or Data Secure with the
  configured group keys
- session keep-alive and timeout, and SESSION_STATUS close

Every frame is logged decrypted. That makes it useful for following a client's
side of the exchange as well as for pass/fail tests.

Frame encoding and the crypto steps come from [XKNX](https://github.com/XKNX/xknx)
(MIT). The gateway logic is written here.

## Setup

```sh
./setup.sh                  # creates .venv with requirements.txt (python3 >= 3.10)
```

## Run

```sh
.venv/bin/python securegw.py -c config.example.json          # 127.0.0.1:3671
.venv/bin/python securegw.py -c config.example.json -p 13671 --fault auth_failed
```

`config.example.json` has dummy values. To test a real project's values, copy it
to `config.local.json`, which is git-ignored, and fill in:

| key | meaning |
|---|---|
| `listen`, `port` | where to listen (default 127.0.0.1:3671) |
| `serial` | the gateway's KNX serial number (12 hex digits) |
| `device_authentication_code` | the device authentication code (plain text, as in ETS) |
| `users` | `{ "<user id>": { "password": "...", "tunnel": "<tunnel individual address>" } }` |
| `group_keys` | Data Secure keys, `{ "<ga>": "<base64 16-byte key>" }`, as in the ETS project |
| `telegrams` | sent in a loop after the client connects: `{ "ga", "bits": n }` (DPT 1-like) or `{ "ga", "bytes": "<hex>" }`, optional `"src"`; keyed GAs are sent Data Secure |
| `interval` | seconds between telegrams (default 2) |
| `fault` | as `--fault` |

## Faults

`--fault` makes the gateway misbehave on purpose, to test a client's error handling:

| fault | what the gateway does |
|---|---|
| `auth_failed` | SESSION_STATUS 1 (authentication failed), whatever the password |
| `unauthenticated` | SESSION_STATUS 2 (refuses the session) |
| `bad_session_mac` | SESSION_RESPONSE with a wrong MAC, as an impostor would send |
| `no_session_response` | ignores SESSION_REQUEST |
| `status_timeout`, `status_close` | SESSION_STATUS 3 / 5 a few seconds after the tunnel is up |
| `no_more_connections` | CONNECT_RESPONSE E_NO_MORE_CONNECTIONS |
| `silent_heartbeat` | stops answering CONNECTIONSTATE_REQUEST |
| `wrong_group_key` | Data Secure telegrams encrypted with the wrong key |
| `plain_to_keyed` | keyed group addresses sent as plain telegrams |
| `stale_wrapper` | one SECURE_WRAPPER reusing an old sequence number (a replay) |

## Clients

- `xknx_client.py <config> [seconds] [port]`: XKNX's own secure client, the
  reference. It should receive every telegram, Data Secure ones included.
- `shim_client.js <config> [seconds] [port]`: hamon's KNXUltimate shim
  (`src/ultimate-shim.js`), the same code path hamon's workers use.
- `run_faults.sh [config] [fault ...]`: runs the shim once per fault and prints
  a summary line each (sessions, connects, telegrams received, errors).

## Limits

- It simulates our reading of the specification, checked against XKNX, not a
  particular product. Test against a real secure gateway as well before
  relying on a client in the field.
- Tunnelling over TCP only. No secure routing (multicast), no device
  management or commissioning (ETS downloading keys into a device).
