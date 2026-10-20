import type {DeliveryConfiguration} from '../../core/src/delivery-config.js';
/** Capabilities of this runner's nativeReleaseInspector, checked before activation. */
export function verifyReleaseFormatCapabilities(configuration:DeliveryConfiguration):void {
  if(!configuration.delivery.githubRelease.enabled)return;
  for(const id of configuration.delivery.githubRelease.builds) {
    const build=configuration.builds[id]!;
    const windows=build.profile==='dotnet-assets-v1' || (build.profile==='custom-adapter-v1' && build.inputs.runnerFamily==='windows');
    for(const output of build.outputs) {
      const pattern=output.match?.replaceAll('{version}','1.0.0');
      if(pattern!=='package.json' && !(windows && pattern && /\.(exe|dll|zip)$/.test(pattern)))
        throw Error('RN_CONFIG_RELEASE_VERSION_INSPECTOR');
    }
  }
}
