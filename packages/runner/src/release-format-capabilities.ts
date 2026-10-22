import type {DeliveryConfiguration} from '../../core/src/delivery-config.js';
/** Capabilities of this runner's nativeReleaseInspector, checked before activation. */
export function verifyReleaseFormatCapabilities(configuration:DeliveryConfiguration):void {
  for(const build of Object.values(configuration.builds)) verifyBuildExecutionCapabilities(build);
  if(!configuration.delivery.githubRelease.enabled)return;
  for(const id of configuration.delivery.githubRelease.builds) {
    const build=configuration.builds[id]!;
    const windows=build.profile==='dotnet-assets-v1' || (build.profile==='custom-adapter-v1' && build.inputs.runnerFamily==='windows');
    for(const output of build.outputs) {
      const pattern=output.match?.replaceAll('{version}','1.0.0');
      if(pattern!=='package.json' && !(windows && pattern && (/\.(exe|dll)$/.test(pattern) || (pattern.endsWith('.zip') && output.mediaType === 'application/zip' &&
        (output.archiveType === 'dll-archive' || (output.archiveType === 'font-archive' && output.count === 1 && !/[{}*?\[\]]/u.test(output.match!)))))))
        throw Error('RN_CONFIG_RELEASE_VERSION_INSPECTOR');
    }
  }
}

export function verifyBuildExecutionCapabilities(build:{profile:string;outputs:readonly unknown[]}):void {
  if(build.profile==='oci-image-v1' && build.outputs.length!==1) throw Error('BUILD_OCI_OUTPUT');
}
