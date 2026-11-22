"""
Tests for StreamHub's patch of the streamlink-ttvlol Twitch plugin (ad-free backup stream during ad breaks).

Run with the built plugin: STREAMHUB_TWITCH_PLUGIN=path/to/twitch.py pytest plugin/tests
"""

import importlib.util
import os
import sys
from collections import deque
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from streamlink.stream.hls import parse_m3u8


spec = importlib.util.spec_from_file_location("streamhub_twitch", os.environ["STREAMHUB_TWITCH_PLUGIN"])
twitch = importlib.util.module_from_spec(spec)
# dataclasses look up their module in sys.modules while the module is executed
sys.modules[spec.name] = twitch
spec.loader.exec_module(twitch)

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def media_playlist(segments, sequence=100):
    """segments: list of (uri, seconds after T0, is_ad)"""
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", f"#EXT-X-MEDIA-SEQUENCE:{sequence}"]
    for uri, offset, ad in segments:
        date = (T0 + timedelta(seconds=offset)).isoformat().replace("+00:00", "Z")
        lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{date}")
        lines.append(f"#EXTINF:2.000,{'Amazon' if ad else 'live'}")
        lines.append(uri)
    return "\n".join(lines) + "\n"


def parse(text, uri="https://primary/media.m3u8"):
    return parse_m3u8(text, uri, parser=twitch.TwitchM3U8Parser)


def fake_worker(backup_segments):
    return SimpleNamespace(
        stream=SimpleNamespace(backup=SimpleNamespace(segments=lambda: backup_segments)),
        backup_written=deque(maxlen=64),
        _match_backup_segment=twitch.TwitchHLSStreamWorker._match_backup_segment,
    )


def test_ad_segments_detected():
    playlist = parse(media_playlist([("https://p/1.ts", 0, False), ("https://p/2.ts", 2, True)]))
    assert [segment.ad for segment in playlist.segments] == [False, True]


def test_substitute_ads_with_backup_segments():
    primary = parse(media_playlist([
        ("https://p/1.ts", 0, False),
        ("https://p/ad1.ts", 2, True),
        ("https://p/ad2.ts", 4, True),
    ]))
    backup = parse(media_playlist([
        ("https://b/0.ts", 0, False),
        ("https://b/1.ts", 2, False),
        ("https://b/2.ts", 4, False),
    ]), "https://backup/media.m3u8").segments

    covered = twitch.TwitchHLSStreamWorker._substitute_ads(fake_worker(backup), primary)

    assert covered is True
    assert [segment.uri for segment in primary.segments] == ["https://p/1.ts", "https://b/1.ts", "https://b/2.ts"]
    assert [segment.ad for segment in primary.segments] == [False, False, False]
    assert [segment.num for segment in primary.segments] == [100, 101, 102], "keeps the primary sequence numbers"
    assert primary.segments[1].discontinuity is True, "tells the player about the switch"


def test_backup_segments_are_not_written_twice():
    backup = parse(media_playlist([("https://b/1.ts", 2, False)]), "https://backup/media.m3u8").segments
    worker = fake_worker(backup)

    first = parse(media_playlist([("https://p/ad1.ts", 2, True)]))
    assert twitch.TwitchHLSStreamWorker._substitute_ads(worker, first) is True

    # next playlist reload: a new ad segment, but the only backup segment was already written
    second = parse(media_playlist([("https://p/ad2.ts", 4, True)], sequence=101))
    assert twitch.TwitchHLSStreamWorker._substitute_ads(worker, second) is False
    assert second.segments[0].ad is True, "unmatched ad segments are still filtered"


def test_no_substitution_for_distant_timestamps():
    primary = parse(media_playlist([("https://p/ad1.ts", 2, True)]))
    backup = parse(media_playlist([("https://b/1.ts", 60, False)]), "https://backup/media.m3u8").segments

    assert twitch.TwitchHLSStreamWorker._substitute_ads(fake_worker(backup), primary) is False
    assert primary.segments[0].ad is True


def test_no_backup_stream_available():
    primary = parse(media_playlist([("https://p/ad1.ts", 2, True)]))
    assert twitch.TwitchHLSStreamWorker._substitute_ads(fake_worker(None), primary) is False


class FakePlugin:
    """Serves a multivariant + media playlist per player type; `ads` lists the player types whose stream has ads"""

    def __init__(self, ads):
        self.ads = ads
        self.token_requests = []
        self.api = SimpleNamespace(access_token_params={"playerType": "embed", "platform": "site"})
        self.usher = SimpleNamespace(channel=lambda channel, **params: f"https://usher/{params['token']}.m3u8")
        self.session = SimpleNamespace(http=SimpleNamespace(get=self.get))

    def _access_token(self, is_live, channel):
        player_type = self.api.access_token_params["playerType"]
        self.token_requests.append(player_type)
        return "sig", player_type, []

    def get(self, url, proxies=None):
        assert proxies == {}, "backup requests don't go through the playlist proxy"
        if url.startswith("https://usher/"):
            player_type = url[len("https://usher/"):-len(".m3u8")]
            return "\n".join([
                "#EXTM3U",
                '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,VIDEO="720p60"',
                f"https://h/{player_type}/720.m3u8",
                '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,VIDEO="360p30"',
                f"https://h/{player_type}/360.m3u8",
            ]) + "\n"
        player_type = url.split("/")[3]
        return media_playlist([(f"https://h/{player_type}/1.ts", 2, player_type in self.ads)])


def test_backup_stream_picks_first_ad_free_player_type():
    plugin = FakePlugin(ads=["autoplay"])
    backup = twitch.TwitchBackupStream(plugin, "channel")

    segments = backup.segments()

    assert [segment.uri for segment in segments] == ["https://h/picture-by-picture/1.ts"]
    assert backup.player_type == "picture-by-picture"
    assert backup.media_url == "https://h/picture-by-picture/360.m3u8", "prefers the 360p variant"
    assert plugin.token_requests == ["autoplay", "picture-by-picture"]
    assert plugin.api.access_token_params == {"playerType": "embed", "platform": "site"}, "restores the token params"

    # reuses the chosen backup stream on the next reload
    backup.segments()
    assert plugin.token_requests == ["autoplay", "picture-by-picture"]


def test_backup_stream_unavailable_waits_before_retrying():
    plugin = FakePlugin(ads=list(twitch.TwitchBackupStream.PLAYER_TYPES))
    backup = twitch.TwitchBackupStream(plugin, "channel")

    assert backup.segments() is None
    requests = len(plugin.token_requests)
    assert requests == len(twitch.TwitchBackupStream.PLAYER_TYPES)

    assert backup.segments() is None
    assert len(plugin.token_requests) == requests, "doesn't query Twitch again right away"


def test_backup_stream_custom_player_types():
    plugin = FakePlugin(ads=[])
    backup = twitch.TwitchBackupStream(plugin, "channel", ["site"])

    segments = backup.segments()
    assert plugin.token_requests == ["site"]
    assert [segment.uri for segment in segments] == ["https://h/site/1.ts"], "finds the backup stream"


def test_plugin_arguments():
    names = [argument.name for argument in twitch.Twitch.arguments]
    assert "backup-stream" in names
    assert "backup-stream-player-types" in names
    assert "proxy-playlist" in names


class ProxyPlugin:
    """A stand-in for the Twitch plugin, for PlaylistProxyService."""

    def __init__(self, proxies, results, fallback=False):
        self.options = {"proxy-playlist": proxies, "proxy-playlist-fallback": fallback}
        self.results = list(results)
        self.used_proxies = []
        self.api = SimpleNamespace(is_channel_live=lambda channel: True)
        self.session = SimpleNamespace(http=SimpleNamespace(headers={}, proxies={}))

    def get_option(self, name):
        return self.options.get(name)

    def _get_hls_streams_live(self, channel):
        self.used_proxies.append(dict(self.session.http.proxies).get("https", "direct"))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def test_http_proxy_failure_tries_the_next_proxy():
    from streamlink.exceptions import PluginError

    plugin = ProxyPlugin(
        ["httpproxy://down.example:2023", "httpproxy://empty.example:2023", "httpproxy://up.example:2023"],
        [PluginError("Unable to connect to proxy"), None, {"best": "stream"}],
    )
    streams = twitch.PlaylistProxyService(plugin).streams("channel")

    assert streams == {"best": "stream"}
    assert plugin.used_proxies == ["http://down.example:2023", "http://empty.example:2023", "http://up.example:2023"]
    assert plugin.session.http.proxies == {}


def test_http_proxy_failures_never_fall_back_to_twitch():
    from streamlink.exceptions import NoStreamsError, PluginError
    import pytest

    plugin = ProxyPlugin(["httpproxy://down.example:2023"], [PluginError("Unable to connect to proxy")])
    with pytest.raises(NoStreamsError):
        twitch.PlaylistProxyService(plugin).streams("channel")
    assert plugin.used_proxies == ["http://down.example:2023"], "no direct request to Twitch"
