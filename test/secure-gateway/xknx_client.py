#!/usr/bin/env python3
"""xknx_client.py - connect XKNX's secure tunnelling client to the simulator (reference client)."""
import asyncio, base64, json, sys
from xknx import XKNX
from xknx.io import ConnectionConfig, ConnectionType, SecureConfig
from xknx.telegram import GroupAddress, IndividualAddress

async def main(cfg_path, seconds, port=None, user="2"):
    cfg = json.load(open(cfg_path))
    u = cfg["users"][user]
    got = []
    def cb(t): got.append(t); print("  rx", t.source_address, "->", t.destination_address, t.payload)
    xknx = XKNX(connection_config=ConnectionConfig(
        connection_type=ConnectionType.TUNNELING_TCP_SECURE, gateway_ip=cfg.get("listen", "127.0.0.1"),
        gateway_port=port or cfg.get("port", 3671), individual_address=u["tunnel"],
        secure_config=SecureConfig(user_id=int(user), user_password=u["password"],
                                   device_authentication_password=cfg["device_authentication_code"])),
        telegram_received_cb=cb)
    # XKNX's Data Secure needs keys in its table to decrypt
    from xknx.secure.data_secure import DataSecure
    await xknx.start()
    xknx.cemi_handler.data_secure = DataSecure(
        group_key_table={GroupAddress(g): base64.b64decode(k)[:16] for g, k in cfg.get("group_keys", {}).items()},
        # XKNX drops Data Secure frames from senders it doesn't know
        individual_address_table={IndividualAddress(t.get("src", "1.1.20")): 0 for t in cfg.get("telegrams", [])})
    await asyncio.sleep(seconds)
    await xknx.stop()
    print(f"received {len(got)} telegrams")

asyncio.run(main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 8,
                 int(sys.argv[3]) if len(sys.argv) > 3 else None))
