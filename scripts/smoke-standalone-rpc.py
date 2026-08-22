#!/usr/bin/env python3
"""Run a real prompt through a packaged pi standalone RPC server."""

import argparse
import json
import os
import select
import subprocess
import time
from pathlib import Path
from typing import cast


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("standalone_dir", type=Path, help="directory containing cli.mjs")
    parser.add_argument("--node", default=os.environ.get("NODE24"), help="Node executable (default: $NODE24)")
    parser.add_argument(
        "--provider",
        default=os.environ.get("PI_SMOKE_PROVIDER"),
        help="model provider (default: $PI_SMOKE_PROVIDER)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("PI_SMOKE_MODEL"),
        help="model ID (default: $PI_SMOKE_MODEL)",
    )
    parser.add_argument("--prompt", default="Say exactly: ok")
    parser.add_argument("--expect", default="ok", help="expected assistant text after stripping whitespace")
    parser.add_argument("--timeout", type=float, default=180, help="timeout in seconds")
    args = parser.parse_args()
    for name in ("node", "provider", "model"):
        if not getattr(args, name):
            parser.error(f"--{name} or its corresponding environment variable is required")
    if not (args.standalone_dir / "cli.mjs").is_file():
        parser.error(f"cli.mjs not found in {args.standalone_dir}")
    return args


def main() -> None:
    args = parse_args()
    env = os.environ.copy()
    env["HOME"] = str(args.standalone_dir / "home")
    process = subprocess.Popen(
        [
            args.node,
            "./cli.mjs",
            "--mode",
            "rpc",
            "--no-session",
            "--provider",
            args.provider,
            "--model",
            args.model,
        ],
        cwd=args.standalone_dir,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdin is not None
    assert process.stdout is not None

    def send(command: dict[str, object]) -> None:
        process.stdin.write(json.dumps(command) + "\n")
        process.stdin.flush()

    deadline = time.monotonic() + args.timeout

    def receive() -> dict[str, object]:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
            raise TimeoutError("timed out waiting for RPC event")
        line = process.stdout.readline()
        if not line:
            stderr = process.stderr.read() if process.stderr is not None else ""
            raise RuntimeError(f"RPC process exited with {process.poll()}: {stderr}")
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RuntimeError(f"unexpected RPC record: {event!r}")
        return cast(dict[str, object], event)

    try:
        send({"id": "prompt", "type": "prompt", "message": args.prompt})
        while True:
            event = receive()
            if event.get("type") == "response" and event.get("id") == "prompt":
                if not event.get("success"):
                    raise RuntimeError(f"prompt rejected: {event}")
                print("PROMPT_ACCEPTED=true")
            elif event.get("type") == "agent_settled":
                print("AGENT_SETTLED=true")
                break

        send({"id": "last-text", "type": "get_last_assistant_text"})
        while True:
            event = receive()
            if event.get("type") != "response" or event.get("id") != "last-text":
                continue
            if not event.get("success"):
                raise RuntimeError(f"get_last_assistant_text failed: {event}")
            data = event.get("data")
            text = data.get("text") if isinstance(data, dict) else None
            print(f"ASSISTANT_TEXT={text!r}")
            if not isinstance(text, str) or text.strip() != args.expect:
                raise RuntimeError(f"unexpected assistant response: {text!r}")
            break
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)

    print("RPC_SMOKE=passed")


if __name__ == "__main__":
    main()
