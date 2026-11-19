// Parses Douyin AR %YAML 1.1 .timeline files on the MCP server side (keeping editor-plugin free of
// third-party npm dependencies). Handles !ScriptCustomExternalObject, !ScriptCustomObject, and !<str>.
import YAML from 'yaml';

const CUSTOM_TAGS = ['!ScriptCustomExternalObject', '!ScriptCustomObject', '!<str>', '!<num>'];

export function parseTimelineYaml(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw Error('TIMELINE_EMPTY: .timeline file is empty');
  }
  const customTags = CUSTOM_TAGS.map((tag) => ({
    tag,
    resolve: (v) => v,
  }));
  const doc = YAML.parse(content, { customTags, logLevel: 'silent' });
  const props = doc?.serializedProperty?.properties;
  if (!props || props.__scriptClassName !== 'TimelineAsset') {
    throw Error(`TIMELINE_INVALID: expected TimelineAsset, got ${props?.__scriptClassName || 'unknown'}`);
  }
  const tracks = (Array.isArray(props.tracks) ? props.tracks : []).map((t, index) => {
    const tp = t?.serializedProperty?.properties || {};
    const clips = (Array.isArray(tp.clips) ? tp.clips : []).map((c) => {
      const cp = c?.serializedProperty?.properties || {};
      return {
        clip_type: cp.__scriptClassName || null,
        start_time: cp.startTime ?? null,
        end_time: cp.endTime ?? null,
      };
    });
    const kfProps = tp.m_keyframeTrack?.serializedProperty?.properties || null;
    return {
      index,
      track_name: tp.trackName ?? '',
      track_type: tp.__scriptClassName || null,
      clips,
      keyframe_track: kfProps ? { track_name: kfProps.trackName ?? '', track_type: kfProps.__scriptClassName || null } : null,
    };
  });
  return {
    name: doc.name ?? '',
    duration_mode: props.durationMode ?? 0,
    fixed_duration: props.fixedDuration ?? 0,
    frame_rate: props.frameRate ?? 30,
    muted: Boolean(props.muted),
    volume: props.volume ?? 100,
    tracks,
  };
}
