#!/usr/bin/env bash
set -euo pipefail

: "${NODE24:?Set NODE24 to the nodejs-wheel-binaries Node 24 executable}"
: "${PI_SMOKE_PROVIDER:?Set PI_SMOKE_PROVIDER}"
: "${PI_SMOKE_MODEL:?Set PI_SMOKE_MODEL}"

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temp_parent=${TMPDIR:-/tmp}
temp_parent=${temp_parent%/}
work_dir=$(mktemp -d "$temp_parent/pi-fork-release-smoke.XXXXXX")
touch "$work_dir/.pi-fork-release-smoke-owned"

cleanup() {
	local status=$?
	trap - EXIT

	case "$work_dir" in
		"$temp_parent"/pi-fork-release-smoke.*)
			if [[ -d "$work_dir" && ! -L "$work_dir" && -f "$work_dir/.pi-fork-release-smoke-owned" ]]; then
				rm -rf -- "$work_dir"
			else
				printf 'Refusing to remove unverified smoke directory: %s\n' "$work_dir" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf 'Refusing to remove unexpected smoke directory: %s\n' "$work_dir" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

cd "$repo"

pack_dir="$work_dir/pack"
npm_smoke_dir="$work_dir/npm-smoke"
unpack_dir="$work_dir/unpack"
standalone_dir="$work_dir/standalone"
mkdir -p "$pack_dir" "$npm_smoke_dir" "$unpack_dir" "$standalone_dir"

tarball_name=$(npm pack -w packages/coding-agent --pack-destination "$pack_dir" --silent)
tarball="$pack_dir/$tarball_name"
printf 'PACKED_TARBALL=%s\n' "$tarball_name"

(
	cd "$npm_smoke_dir"
	npm install "$tarball"
	npx pi --help >/dev/null
	npx pi --version
	npx pi --provider "$PI_SMOKE_PROVIDER" --model "$PI_SMOKE_MODEL" -p "Say exactly: ok"
)

tar -xzf "$tarball" -C "$unpack_dir"
cp -R "$unpack_dir/package/dist/standalone/." "$standalone_dir/"

(
	cd "$standalone_dir"
	test ! -d node_modules
	file_count=$(find . -type f | wc -l | tr -d ' ')
	test "$file_count" -le 30
	printf 'STANDALONE_FILES=%s\n' "$file_count"
	printf 'STANDALONE_SIZE_BYTES=%s\n' "$(du -sk . | awk '{print $1 * 1024}')"
	HOME="$standalone_dir/home" "$NODE24" ./cli.mjs --help >/dev/null
	HOME="$standalone_dir/home" "$NODE24" ./cli.mjs --version
	printf '%s\n' '{"id":"smoke","type":"get_state"}' | \
		HOME="$standalone_dir/home" "$NODE24" ./cli.mjs --mode rpc --no-session \
			--provider "$PI_SMOKE_PROVIDER" --model "$PI_SMOKE_MODEL"
	"$NODE24" "$repo/scripts/smoke-standalone-image-resize.mjs" "$standalone_dir"
)

python3 "$repo/scripts/smoke-standalone-rpc.py" "$standalone_dir"
printf 'RELEASE_SMOKE=passed\n'
