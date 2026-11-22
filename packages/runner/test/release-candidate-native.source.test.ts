import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeCandidateCases } from './release-candidate-native-fixture.js';

const { mergedContributorIdentity } = await import(pathToFileURL(resolve('scripts/release-candidate.mjs')).href);

it('projects legacy web-flow cache at merge while preserving original actors and rejecting other drift', () => {
  const bot = {id:19864447, login:'web-flow', type:'User', profileUrl:'https://github.com/web-flow', avatarUrl:'https://avatars.githubusercontent.com/u/19864447?v=4'};
  const person = {id:45, login:'human', type:'User', profileUrl:'https://github.com/human', avatarUrl:'https://avatars.githubusercontent.com/u/45'};
  const contributor = ({id, login, profileUrl, avatarUrl}:typeof bot) => ({id, login, profileUrl, avatarUrl, alt:login});
  const scope = {actors:[bot, person, null], contributors:{contributors:[contributor(person),contributor(bot)], unresolved:1}};
  const frozen = {...scope, units:[{...scope, id:'app'}]};
  const authors = [{id:7, evidence:'verified repository author'}];
  const projected = mergedContributorIdentity(frozen,authors);
  expect(projected.contributors).toEqual({contributors:[contributor(person)], unresolved:1});
  expect(projected.units[0].contributors).toEqual(projected.contributors);
  expect(projected.actors).toBe(frozen.actors);
  expect(frozen.contributors.contributors).toHaveLength(2);
  expect(mergedContributorIdentity(projected,authors)).toEqual(projected);
  const corrupt = structuredClone(frozen);
  corrupt.units[0]!.contributors.unresolved++;
  expect(()=>mergedContributorIdentity(corrupt,authors)).toThrow('MERGED_CANDIDATE_CONTRIBUTOR_DRIFT');
});
nativeCandidateCases(['old-source', 'new-source', 'missing-pin', 'conflicting-pin']);
