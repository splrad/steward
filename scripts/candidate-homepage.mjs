import { setTimeout as delay } from 'node:timers/promises';

const maxBodyCharacters = 65536;
const editing = '编辑发布说明文件前，添加 `release:editing` 标签，等正在写入候选分支的作业结束后再修改。';
const oldPreview = /^(?:当前版本和发布说明见\[候选状态\]\(https:\/\/github\.com\/[^)\r\n]+\/pull\/[0-9]+#issuecomment-[0-9]+\)。下方是创建 PR 时的变更记录。)(?:\r?\n){2}/;
const oldStatusHint = /(?:^|(?:\r?\n){2})当前文稿的预览见本 PR 的 Steward 状态评论。$/;
const reserved = /<!-- (?:\/?steward:candidate-homepage|steward:candidate):/;
const pathUrl = path => path.split('/').map(encodeURIComponent).join('/');
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function fitsPullBody(body) {
  let length = 0;
  for (const character of body) {
    if (++length > maxBodyCharacters) return false;
  }
  return true;
}

function creationRecord(body, marker, start, end) {
  const startAt = body.indexOf(start), endAt = body.indexOf(end);
  if (startAt >= 0 || endAt >= 0) {
    if (startAt < 0 || endAt <= startAt || !body.includes(marker)
      || body.indexOf(start, startAt + start.length) >= 0 || body.indexOf(end, endAt + end.length) >= 0)
      throw Error('CANDIDATE_HOMEPAGE_MARKERS');
    return body.slice(startAt + start.length, endAt).trim();
  }

  const original = body.replaceAll(marker, '').trim().replace(oldPreview, '').replace(oldStatusHint, '');
  const record = original.endsWith(editing) ? original.slice(0, -editing.length).trimEnd() : original;
  // Legacy #201 already contains one collapsed creation snapshot.
  const details = /^<details>\s*<summary>[^\r\n]*?<\/summary>([\s\S]*)<\/details>$/i.exec(record);
  return (details && !/<\/details>/i.test(details[1]) ? details[1] : record).trim();
}

export function renderCandidateHomepage(prBody, { candidate, repository, head, notes }) {
  const origin = 'https://github.com/' + repository;
  const marker = '<!-- steward:candidate:' + candidate.id + ' -->';
  const start = '<!-- steward:candidate-homepage:' + candidate.id + ' -->';
  const end = '<!-- /steward:candidate-homepage:' + candidate.id + ' -->';
  const archive = creationRecord(prBody, marker, start, end);
  if (reserved.test(archive) || notes.some(note => reserved.test(note.markdown ?? '')))
    throw Error('CANDIDATE_HOMEPAGE_MARKERS');

  const one = notes.length === 1;
  const source = note => origin + '/blob/' + head + '/' + pathUrl(note.path);
  const edit = note => origin + '/blob/' + pathUrl(candidate.branch) + '/' + pathUrl(note.path);
  const editFiles = one && notes[0].markdown !== null
    ? '[候选分支中的说明文件](' + edit(notes[0]) + ')'
    : '[候选分支](' + origin + '/tree/' + pathUrl(candidate.branch) + ')中的说明文件';
  const intro = '> **候选预览**　如需改稿，请编辑' + editFiles + '并提交，机器人会同步到这里。';
  const links = [
    ...(candidate.statusCommentId === null ? [] : ['[候选状态](' + origin + '/pull/' + candidate.prNumber + '#issuecomment-' + candidate.statusCommentId + ')']),
    '[当前候选提交 `' + head.slice(0, 7) + '`](' + origin + '/commit/' + head + ')',
    ...notes.filter(note => note.markdown !== null).map(note => '[发布说明原稿' + (one ? '' : ' · ' + note.unit) + '](' + source(note) + ')'),
  ];
  const record = archive ? [
    '<details>', '<summary>创建 PR 时的变更记录</summary>', '', start, '', archive, '', end, '', '</details>',
  ].join('\n') : start + '\n' + end;
  const heading = one ? '# 发布说明 · ' + notes[0].version : '# 发布说明';
  const content = notes.map(note => [
    ...(one ? [] : ['## ' + note.unit + ' · ' + note.version]),
    note.markdown?.trimEnd() || '此提交暂无发布说明。',
  ].join('\n\n')).join('\n\n');
  const compose = text => [intro, heading, text, '---', '## PR 信息', links.join(' · '), editing, record, marker].join('\n\n') + '\n';
  const full = compose(content);
  if (fitsPullBody(full)) return full;

  const linked = compose('发布说明超出 PR 正文长度限制。可通过下方「发布说明原稿」查看全文。');
  if (!fitsPullBody(linked)) throw Error('CANDIDATE_HOMEPAGE_BODY_LIMIT');
  return linked;
}

// Run under the candidate PR's concurrency group. The event wakes
// reconciliation; only the live PR and branch select the commit for display.
export async function syncCandidateHomepage({ candidate, units, repository, repositoryId, defaultBranch,
  getPull, fetchHead, readHead, stateCurrent, readFile, updateBody, wait = delay }) {
  const matches = pull => pull?.number === candidate.prNumber && pull.head?.repo?.id === repositoryId
    && pull.head.ref === candidate.branch && pull.base?.repo?.id === repositoryId && pull.base.ref === defaultBranch;
  const open = pull => matches(pull) && pull.state === 'open' && pull.merged === false;
  let reason = 'CANDIDATE_HOMEPAGE_HEAD_MOVED';
  for (const interval of [0, 1000, 3000, 8000]) {
    if (interval) await wait(interval);
    const before = await getPull();
    if (!open(before)) return {status: 'SKIPPED', reason: 'CANDIDATE_HOMEPAGE_NOT_CURRENT'};
    const head = before.head.sha;
    if (!isSha(head) || await fetchHead(candidate.branch) !== head) {
      reason = 'CANDIDATE_HOMEPAGE_HEAD_MOVED';
      continue;
    }

    const manifest = JSON.parse(await readFile(head, '.release-please-manifest.json'));
    const notes = await Promise.all(units.map(async ({ id, path, notesPath }) => {
      const version = manifest[path];
      if (typeof version !== 'string' || !/^[0-9][0-9A-Za-z.+-]*$/.test(version))
        throw Error('CANDIDATE_HOMEPAGE_VERSION');
      return {path: notesPath, unit: id, version, markdown: await readFile(head, notesPath, true)};
    }));

    const latest = await getPull();
    if (!open(latest)) return {status: 'SKIPPED', reason: 'CANDIDATE_HOMEPAGE_NOT_CURRENT'};
    if (!await stateCurrent()) return {status: 'WAIT', reason: 'CANDIDATE_HOMEPAGE_STATE_MOVED'};
    if (latest.head.sha !== head || await readHead(candidate.branch) !== head) {
      reason = 'CANDIDATE_HOMEPAGE_HEAD_MOVED';
      continue;
    }

    const body = renderCandidateHomepage(latest.body ?? '', {candidate, repository, head, notes});
    if (latest.body === body) return {status: 'READY', reason: 'CANDIDATE_HOMEPAGE_CURRENT', head};

    let unconfirmed = false;

    try {
      await updateBody(body);
    } catch (error) {
      if (/^CANDIDATE_NATIVE_HTTP_(?:400|401|403|404|422)$/.test(error?.message)) throw Error('CANDIDATE_HOMEPAGE_WRITE_REJECTED');
      unconfirmed = true;
    }
    // An error can mean GitHub received the write. Reconcile via readback.
    // If it hasn't settled, the next pass reads and renders the live head again.
    if (unconfirmed) await wait(1000);
    let after, branchHead;
    try {
      after = await getPull();
      if (open(after)) branchHead = await readHead(candidate.branch);
    } catch {
      reason = 'CANDIDATE_HOMEPAGE_WRITE_UNKNOWN';
      continue;
    }
    if (!open(after)) return {status: 'SKIPPED', reason: 'CANDIDATE_HOMEPAGE_NOT_CURRENT'};
    if (after.head.sha !== head || branchHead !== head) {
      reason = 'CANDIDATE_HOMEPAGE_HEAD_MOVED';
      continue;
    }
    if (after.body === body) return {status: 'READY', reason: 'CANDIDATE_HOMEPAGE_UPDATED', head};
    reason = 'CANDIDATE_HOMEPAGE_WRITE_UNKNOWN';
  }
  return {status: 'FAILED', reason};
}