#!/usr/bin/env python3
"""
securegw.py - a KNXnet/IP Secure tunnelling gateway simulator, for testing clients.

Listens on TCP and plays the gateway side of a secure tunnelling session:
session request/response (X25519 + device authentication code), user
authentication, then tunnelling inside SECURE_WRAPPERs - connect, connection
state, disconnect, L_Data.req -> L_Data.con - and sends scripted group
telegrams, plain or KNX Data Secure, to the connected client. Every frame is
logged decrypted, so a client's side of the exchange can be followed.

Faults (--fault, or "fault" in the config) make it misbehave on purpose:
  auth_failed         SESSION_STATUS 1 whatever the password
  unauthenticated     SESSION_STATUS 2 (gateway refuses the session)
  bad_session_mac     SESSION_RESPONSE with a wrong MAC (not the real gateway)
  no_session_response ignore SESSION_REQUEST
  status_timeout      SESSION_STATUS 3 a few seconds after connecting
  status_close        SESSION_STATUS 5 a few seconds after connecting
  no_more_connections CONNECT_RESPONSE E_NO_MORE_CONNECTIONS
  silent_heartbeat    stop answering CONNECTIONSTATE_REQUESTs
  wrong_group_key     Data Secure telegrams encrypted with a wrong key
  plain_to_keyed      send keyed group addresses as plain telegrams
  stale_wrapper       one SECURE_WRAPPER with an old sequence number

Frame encoding and the crypto steps come from XKNX (MIT); the gateway logic is
written here. See README.md for setup and the config format.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import sys
import time

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
from xknx.cemi import CEMIFrame, CEMILData, CEMIMessageCode
from xknx.dpt import DPTArray, DPTBinary
from xknx.knxip import (
    HPAI,
    ConnectResponse,
    ConnectionStateResponse,
    DisconnectResponse,
    KNXIPFrame,
    KNXIPServiceType,
    SecureWrapper,
    SessionResponse,
    SessionStatus,
    TunnellingRequest,
)
from xknx.knxip.connect_response import ConnectResponseData
from xknx.knxip.error_code import ErrorCode
from xknx.knxip.knxip_enum import HostProtocol, SecureSessionStatusCode
from xknx.secure.data_secure import DataSecure
from xknx.secure.security_primitives import (
    calculate_message_authentication_code_cbc,
    decrypt_ctr,
    derive_device_authentication_password,
    derive_user_password,
    encrypt_data_ctr,
    generate_ecdh_key_pair,
)
from xknx.secure.util import bytes_xor, sha256_hash
from xknx.telegram import GroupAddress, IndividualAddress, Telegram
from xknx.telegram.apci import GroupValueWrite

log = logging.getLogger("securegw")

COUNTER_0_HANDSHAKE = bytes(14) + b"\xff\x00"
MESSAGE_TAG_TUNNELLING = b"\x00\x00"
SESSION_TIMEOUT = 60  # s without an authenticated frame from the client
FAULTS = ("auth_failed", "unauthenticated", "bad_session_mac", "no_session_response",
          "status_timeout", "status_close", "no_more_connections", "silent_heartbeat",
          "wrong_group_key", "plain_to_keyed", "stale_wrapper")


def ccm_mac(key, header, session_id, seq, serial, tag, payload):
    """CBC-MAC of a SECURE_WRAPPER (header + session id as associated data)."""
    return calculate_message_authentication_code_cbc(
        key=key,
        additional_data=header + session_id.to_bytes(2, "big"),
        payload=payload,
        block_0=seq + serial + tag + len(payload).to_bytes(2, "big"),
    )


class Session:
    """One client TCP connection: secure session, then one tunnel."""

    def __init__(self, gw: Gateway, reader, writer):
        self.gw = gw
        self.reader = reader
        self.writer = writer
        self.peer = writer.get_extra_info("peername")
        self.buf = b""
        self.key = None             # session key, after SESSION_RESPONSE
        self.session_id = None
        self.pub_xor = None
        self.user_id = None         # once authenticated
        self.seq_out = 0
        self.seq_in = -1
        self.channel = None
        self.tunnel_seq = 0
        self.last_rx = time.monotonic()
        self.tasks = []
        self.closed = False

    # ---- transport -------------------------------------------------------

    async def run(self):
        log.info("%s connected", self.peer)
        self.tasks.append(asyncio.create_task(self.watchdog()))
        try:
            while not self.closed:
                data = await self.reader.read(4096)
                if not data:
                    break
                self.buf += data
                while len(self.buf) >= 6:
                    total = int.from_bytes(self.buf[4:6], "big")
                    if self.buf[0:2] != b"\x06\x10" or total < 6:
                        log.warning("%s bad KNX/IP header %s - closing", self.peer, self.buf[:6].hex())
                        return
                    if len(self.buf) < total:
                        break
                    raw, self.buf = self.buf[:total], self.buf[total:]
                    await self.handle_raw(raw)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            self.close("connection ended")

    def close(self, why):
        if self.closed:
            return
        self.closed = True
        for t in self.tasks:
            t.cancel()
        log.info("%s closed: %s", self.peer, why)
        try:
            self.writer.close()
        except Exception:  # noqa: BLE001
            pass

    def send_plain(self, body):
        frame = KNXIPFrame.init_from_body(body)
        log.info("%s -> %s", self.peer, describe(frame))
        self.writer.write(frame.to_knx())

    def send_secure(self, body, seq_override=None):
        plain = KNXIPFrame.init_from_body(body).to_knx()
        seq = (seq_override if seq_override is not None else self.seq_out).to_bytes(6, "big")
        if seq_override is None:
            self.seq_out += 1
        header = bytes.fromhex("06 10 09 50") + (38 + len(plain)).to_bytes(2, "big")
        mac_cbc = ccm_mac(self.key, header, self.session_id, seq, self.gw.serial, MESSAGE_TAG_TUNNELLING, plain)
        encrypted, mac = encrypt_data_ctr(
            key=self.key,
            counter_0=seq + self.gw.serial + MESSAGE_TAG_TUNNELLING + b"\xff\x00",
            mac_cbc=mac_cbc,
            payload=plain,
        )
        wrapper = KNXIPFrame.init_from_body(SecureWrapper(
            secure_session_id=self.session_id, sequence_information=seq, serial_number=self.gw.serial,
            message_tag=MESSAGE_TAG_TUNNELLING, encrypted_data=encrypted, message_authentication_code=mac))
        log.info("%s -> [secure seq %d] %s", self.peer, int.from_bytes(seq, "big"),
                 describe(KNXIPFrame.from_knx(plain)[0]))
        self.writer.write(wrapper.to_knx())

    # ---- receive ---------------------------------------------------------

    async def handle_raw(self, raw):
        try:
            frame, _ = KNXIPFrame.from_knx(raw)
        except Exception as err:  # noqa: BLE001
            log.warning("%s unparsable frame %s (%s)", self.peer, raw.hex(), err)
            return
        st = frame.header.service_type_ident
        if st == KNXIPServiceType.SESSION_REQUEST:
            log.info("%s <- %s", self.peer, describe(frame))
            self.session_request(frame.body)
        elif st == KNXIPServiceType.SECURE_WRAPPER:
            inner = self.unwrap(raw, frame.body)
            if inner is not None:
                self.last_rx = time.monotonic()
                await self.handle_secure(inner)
        else:
            log.warning("%s <- plain %s - ignored (only SESSION_REQUEST may be plain)", self.peer, describe(frame))

    def unwrap(self, raw, body):
        if self.key is None:
            log.warning("%s <- SECURE_WRAPPER before a session - dropped", self.peer)
            return None
        if body.secure_session_id != self.session_id:
            log.warning("%s <- SECURE_WRAPPER for session %d (ours %d) - dropped", self.peer,
                        body.secure_session_id, self.session_id)
            return None
        seq = int.from_bytes(body.sequence_information, "big")
        plain, mac_tr = decrypt_ctr(
            key=self.key,
            counter_0=body.sequence_information + body.serial_number + body.message_tag + b"\xff\x00",
            mac=body.message_authentication_code,
            payload=body.encrypted_data,
        )
        mac_cbc = ccm_mac(self.key, raw[:6], self.session_id, body.sequence_information,
                          body.serial_number, body.message_tag, plain)
        if mac_cbc != mac_tr:
            log.warning("%s <- SECURE_WRAPPER MAC check failed - dropped", self.peer)
            return None
        if seq <= self.seq_in:
            log.warning("%s <- SECURE_WRAPPER seq %d not above %d (replay) - dropped", self.peer, seq, self.seq_in)
            return None
        self.seq_in = seq
        inner, _ = KNXIPFrame.from_knx(plain)
        log.info("%s <- [secure seq %d] %s", self.peer, seq, describe(inner))
        return inner

    # ---- session set-up --------------------------------------------------

    def session_request(self, body):
        if self.gw.fault == "no_session_response":
            log.info("%s (fault) not answering SESSION_REQUEST", self.peer)
            return
        private_key, public_key = generate_ecdh_key_pair()
        client_key = body.ecdh_client_public_key
        self.session_id = self.gw.next_session_id()
        self.pub_xor = bytes_xor(client_key, public_key)
        self.key = sha256_hash(private_key.exchange(X25519PublicKey.from_public_bytes(client_key)))[:16]
        self.seq_out, self.seq_in, self.user_id = 0, -1, None
        mac_cbc = calculate_message_authentication_code_cbc(
            key=self.gw.device_auth_key,
            additional_data=bytes.fromhex("06 10 09 52 00 38") + self.session_id.to_bytes(2, "big") + self.pub_xor,
        )
        _, mac = encrypt_data_ctr(key=self.gw.device_auth_key, counter_0=COUNTER_0_HANDSHAKE, mac_cbc=mac_cbc)
        if self.gw.fault == "bad_session_mac":
            mac = bytes(b ^ 0xFF for b in mac)
        self.send_plain(SessionResponse(secure_session_id=self.session_id, ecdh_server_public_key=public_key,
                                        message_authentication_code=mac))

    def check_user(self, body):
        """SESSION_AUTHENTICATE: the MAC must match one of the configured users' passwords."""
        user = self.gw.users.get(body.user_id)
        if user is None:
            log.info("%s user %d not configured", self.peer, body.user_id)
            return False
        mac_cbc = calculate_message_authentication_code_cbc(
            key=user["key"],
            additional_data=bytes.fromhex("06 10 09 53 00 18") + bytes(1) + body.user_id.to_bytes(1, "big") + self.pub_xor,
            block_0=bytes(16),
        )
        _, mac = encrypt_data_ctr(key=user["key"], counter_0=COUNTER_0_HANDSHAKE, mac_cbc=mac_cbc)
        return mac == body.message_authentication_code

    async def handle_secure(self, frame):
        st = frame.header.service_type_ident
        body = frame.body
        if st == KNXIPServiceType.SESSION_AUTHENTICATE:
            if self.gw.fault == "unauthenticated":
                status = SecureSessionStatusCode.STATUS_UNAUTHENTICATED
            elif self.gw.fault == "auth_failed" or not self.check_user(body):
                status = SecureSessionStatusCode.STATUS_AUTHENTICATION_FAILED
            else:
                status = SecureSessionStatusCode.STATUS_AUTHENTICATION_SUCCESS
                self.user_id = body.user_id
            self.send_secure(SessionStatus(status=status))
            if status != SecureSessionStatusCode.STATUS_AUTHENTICATION_SUCCESS:
                await asyncio.sleep(0.2)
                self.close(f"session status {status.name}")
            return
        if st == KNXIPServiceType.SESSION_STATUS:
            if body.status == SecureSessionStatusCode.STATUS_CLOSE:
                self.close("client sent SESSION_STATUS close")
            return  # keep-alive: last_rx already updated
        if self.user_id is None:
            log.warning("%s %s before authentication - dropped", self.peer, st.name)
            return
        if st == KNXIPServiceType.CONNECT_REQUEST:
            self.connect(body)
        elif st == KNXIPServiceType.CONNECTIONSTATE_REQUEST:
            if self.gw.fault == "silent_heartbeat":
                log.info("%s (fault) not answering CONNECTIONSTATE_REQUEST", self.peer)
                return
            ok = body.communication_channel_id == self.channel
            self.send_secure(ConnectionStateResponse(communication_channel_id=body.communication_channel_id,
                                                     status_code=ErrorCode.E_NO_ERROR if ok else ErrorCode.E_CONNECTION_ID))
        elif st == KNXIPServiceType.DISCONNECT_REQUEST:
            self.send_secure(DisconnectResponse(communication_channel_id=body.communication_channel_id))
            if body.communication_channel_id == self.channel:
                self.channel = None
        elif st == KNXIPServiceType.TUNNELLING_REQUEST:
            self.tunnelling(body)
        else:
            log.info("%s %s not handled", self.peer, st.name)

    # ---- tunnel ----------------------------------------------------------

    def connect(self, body):
        if self.gw.fault == "no_more_connections":
            self.send_secure(ConnectResponse(status_code=ErrorCode.E_NO_MORE_CONNECTIONS))
            return
        self.channel = self.gw.next_channel()
        self.tunnel_seq = 0
        ia = self.gw.users[self.user_id]["tunnel"]
        self.send_secure(ConnectResponse(
            communication_channel=self.channel,
            data_endpoint=HPAI(protocol=HostProtocol.IPV4_TCP),
            crd=ConnectResponseData(individual_address=IndividualAddress(ia))))
        self.tasks.append(asyncio.create_task(self.script()))
        if self.gw.fault in ("status_timeout", "status_close"):
            self.tasks.append(asyncio.create_task(self.status_fault()))

    def tunnelling(self, body):
        """L_Data.req from the client: confirm it (TCP has no TUNNELLING_ACK)."""
        try:
            cemi = CEMIFrame.from_knx(body.raw_cemi)
        except Exception as err:  # noqa: BLE001
            log.warning("%s unparsable cEMI %s (%s)", self.peer, body.raw_cemi.hex(), err)
            return
        log.info("%s    cEMI %s", self.peer, cemi)
        if cemi.code == CEMIMessageCode.L_DATA_REQ:
            cemi.code = CEMIMessageCode.L_DATA_CON
            self.send_tunnel(cemi.to_knx())

    def send_tunnel(self, raw_cemi):
        self.send_secure(TunnellingRequest(communication_channel_id=self.channel,
                                           sequence_counter=self.tunnel_seq, raw_cemi=raw_cemi))
        self.tunnel_seq = (self.tunnel_seq + 1) & 0xFF

    async def script(self):
        """Send the configured telegrams to the client, in a loop."""
        await asyncio.sleep(1)
        sent = 0
        while self.channel is not None and not self.closed:
            for t in self.gw.telegrams:
                if self.channel is None or self.closed:
                    return
                ga = GroupAddress(t["ga"])
                payload = DPTBinary(int(t["bits"])) if "bits" in t else DPTArray(bytes.fromhex(t["bytes"]))
                cemi_data = CEMILData.init_from_telegram(
                    Telegram(destination_address=ga, payload=GroupValueWrite(payload)),
                    src_addr=IndividualAddress(t.get("src", "1.1.20")))
                keyed = ga in self.gw.group_keys
                if keyed and self.gw.fault != "plain_to_keyed":
                    cemi_data = self.gw.data_secure.outgoing_cemi(cemi_data)
                cemi = CEMIFrame(code=CEMIMessageCode.L_DATA_IND, data=cemi_data)
                if self.gw.fault == "stale_wrapper" and sent == 2:
                    log.info("%s (fault) next wrapper reuses sequence number 0", self.peer)
                    self.send_secure(TunnellingRequest(communication_channel_id=self.channel,
                                                       sequence_counter=self.tunnel_seq, raw_cemi=cemi.to_knx()),
                                     seq_override=0)
                else:
                    log.info("%s    %s %s %s", self.peer, "DATA SECURE" if keyed and self.gw.fault != "plain_to_keyed" else "plain",
                             ga, t.get("bits", t.get("bytes")))
                    self.send_tunnel(cemi.to_knx())
                sent += 1
                await asyncio.sleep(self.gw.interval)

    async def status_fault(self):
        await asyncio.sleep(5)
        status = (SecureSessionStatusCode.STATUS_TIMEOUT if self.gw.fault == "status_timeout"
                  else SecureSessionStatusCode.STATUS_CLOSE)
        log.info("%s (fault) sending SESSION_STATUS %s", self.peer, status.name)
        self.send_secure(SessionStatus(status=status))
        await asyncio.sleep(0.2)
        self.close(f"fault {self.gw.fault}")

    async def watchdog(self):
        while not self.closed:
            await asyncio.sleep(5)
            if self.key is not None and time.monotonic() - self.last_rx > SESSION_TIMEOUT:
                if self.user_id is not None:
                    self.send_secure(SessionStatus(status=SecureSessionStatusCode.STATUS_TIMEOUT))
                self.close(f"no frame from the client for {SESSION_TIMEOUT} s")


class Gateway:
    def __init__(self, cfg, fault):
        self.serial = bytes.fromhex(cfg.get("serial", "00fa00000001"))
        self.device_auth_key = derive_device_authentication_password(cfg["device_authentication_code"])
        self.users = {int(uid): {"key": derive_user_password(u["password"]), "tunnel": u["tunnel"]}
                      for uid, u in cfg["users"].items()}
        self.group_keys = {GroupAddress(ga): base64.b64decode(k)[:16] for ga, k in cfg.get("group_keys", {}).items()}
        keys = self.group_keys
        if fault == "wrong_group_key":
            keys = {ga: bytes(b ^ 0x5A for b in k) for ga, k in keys.items()}
        self.data_secure = DataSecure(group_key_table=keys, individual_address_table={}) if keys else None
        self.telegrams = cfg.get("telegrams", [])
        self.interval = float(cfg.get("interval", 2))
        self.fault = fault
        self._session = int.from_bytes(os.urandom(2), "big") % 0xFFF0 + 1
        self._channel = 0

    def next_session_id(self):
        self._session = self._session % 0xFFFE + 1
        return self._session

    def next_channel(self):
        self._channel = self._channel % 0xFF + 1
        return self._channel


def describe(frame):
    body = frame.body
    name = frame.header.service_type_ident.name
    fields = {
        "SessionStatus": lambda b: b.status.name,
        "SessionAuthenticate": lambda b: f"user {b.user_id}",
        "SessionResponse": lambda b: f"session {b.secure_session_id}",
        "ConnectResponse": lambda b: f"channel {b.communication_channel} {b.status_code.name}"
                                     + (f" ia {b.crd.individual_address}" if b.crd and b.crd.individual_address else ""),
        "ConnectionStateRequest": lambda b: f"channel {b.communication_channel_id}",
        "ConnectionStateResponse": lambda b: f"channel {b.communication_channel_id} {b.status_code.name}",
        "DisconnectRequest": lambda b: f"channel {b.communication_channel_id}",
        "DisconnectResponse": lambda b: f"channel {b.communication_channel_id}",
        "TunnellingRequest": lambda b: f"channel {b.communication_channel_id} seq {b.sequence_counter} cemi {b.raw_cemi.hex()}",
    }
    f = fields.get(type(body).__name__)
    return f"{name} {f(body)}" if f else name


async def main():
    ap = argparse.ArgumentParser(description="KNXnet/IP Secure tunnelling gateway simulator")
    ap.add_argument("-c", "--config", required=True, help="JSON config (see config.example.json)")
    ap.add_argument("-l", "--listen", help="address to listen on (default from config, else 127.0.0.1)")
    ap.add_argument("-p", "--port", type=int, help="TCP port (default from config, else 3671)")
    ap.add_argument("-f", "--fault", choices=FAULTS, help="misbehave on purpose (see --help text)")
    ap.add_argument("-v", "--verbose", action="store_true", help="also log XKNX debug output")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s.%(msecs)03d %(message)s", datefmt="%H:%M:%S")
    if not args.verbose:
        logging.getLogger("xknx").setLevel(logging.WARNING)
    with open(args.config) as f:
        cfg = json.load(f)
    gw = Gateway(cfg, args.fault or cfg.get("fault"))
    host = args.listen or cfg.get("listen", "127.0.0.1")
    port = args.port or cfg.get("port", 3671)
    server = await asyncio.start_server(lambda r, w: Session(gw, r, w).run(), host, port)
    log.info("secure gateway on %s:%d serial %s, %d user(s), %d group key(s), fault %s",
             host, port, gw.serial.hex(), len(gw.users), len(gw.group_keys), gw.fault or "none")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
