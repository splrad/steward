import {ciPath,deliveryPath,inspectRepository,pagesChoices,pagesPath,publishPath,versionsPath} from './configuration-view.mjs';
import {productWorkflows,requiresProductCI,selectableProductCI} from './validation-input.mjs';
import {dependencyMode,loadPolicy} from './private-dependency-policy.mjs';
import {checkedRegistration,releaseRegistration} from './repository-registration-policy.mjs';

export async function registrationProposal(repo, read, productPaths) {
  const paths = [ciPath, deliveryPath, publishPath, versionsPath, pagesPath];
  const files = new Map((await Promise.all(paths.map(async path => [path, await read(path)])))
    .filter(([, text]) => text !== null));
  const ci = files.has(ciPath) ? JSON.parse(files.get(ciPath)) : [];
  const ciPaths = files.has(ciPath) ? productWorkflows(ci, ci) : [];
  for (const path of ciPaths) {
    const text = await read(path);
    if (text !== null) files.set(path, text);
  }
  const model = inspectRepository(files);
  const pending = [];
  let productCiApplicable=files.has(ciPath);
  if(productPaths&&!productCiApplicable) {
    const policy=await loadPolicy();
    productCiApplicable=requiresProductCI(productPaths,dependencyMode({repository:repo},policy),
      policy.administrators.find(item=>item.repositoryId===repo.id));
  }
  const productCi = ciPaths.filter(path => model.workflows.some(workflow =>
    workflow.path === path && selectableProductCI(workflow, repo.default_branch)));
  if ((productCiApplicable&&!ciPaths.length)||productCi.length!==ciPaths.length) pending.push('复核产品 CI 工作流或触发条件');
  const priorPending=pending.length;
  const {release,nativeReleaseUnits} = releaseRegistration(model, pending);
  const releaseIncomplete=pending.length>priorPending;
  const choice = pagesChoices(model.pages);
  const validSiteUnit=choice.source!=='release'||(nativeReleaseUnits
    ?nativeReleaseUnits.includes(choice.unit):release?.units.some(unit=>unit.id===choice.unit));
  let site = null;
  if (choice.build && choice.source && validSiteUnit) {
    site = { workflow: pagesPath, mode: 'build-only', source: choice.source,
      ...(choice.source === 'release' ? { unit: choice.unit } : {}) };
  }
  if (choice.build || choice.deploy) {
    if (!choice.source) pending.push('确认站点构建来源');
    else if (!validSiteUnit) pending.push('确认站点的正式 Release 单元');
    if (choice.deploy && !choice.build) pending.push('确认公开部署所需的站点构建选择');
    if (choice.deploy) pending.push('确认公开部署授权');
  }
  const matrix = model.publish?.jobs?.build?.strategy?.matrix?.include;
  const rows = Array.isArray(matrix) ? matrix : [];
  const releaseDetails = new Map((model.delivery?.units ?? []).map(unit => [unit.id, {
    assets: new Map(unit.assets.map(asset => [asset.id, asset.name])),
    targets: rows.filter(row => row?.unit === unit.id && typeof row.target === 'string' && row.target).map(row => row.target)
  }]));
  const nativeReleaseSite=nativeReleaseUnits&&site?.source==='release'?site:null;
  return { policy: checkedRegistration({ schemaVersion: 1, repositoryId: repo.id, repository: repo.full_name,
    productCi, release, site:nativeReleaseSite?null:site }, repo.id), pending, releaseDetails, productCiApplicable,
    releaseIncomplete, nativeReleaseUnits, nativeReleaseSite };
}

export function registrationProductPaths(tree) {
  if(tree.truncated!==false||!Array.isArray(tree.tree))throw Error('Incomplete product registration tree');
  return tree.tree.filter(entry=>entry.type!=='tree').map(entry=>entry.path);
}
