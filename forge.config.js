module.exports = {
	packagerConfig: {
		// set config executableName
		executableName: "wlhlgate",
		icon: './icon',
		asar: true,
	},
	publishers: [
		{
			name: '@electron-forge/publisher-github',
			config: {
				repository: {
					owner: 'CS8ABG',
					name: 'WaveLogHamlibGate'
				},
				prerelease: false
			}
		}
	],
	rebuildConfig: {},
	makers: [
		{
			name: '@electron-forge/maker-squirrel',
			config: { icon: "./icon.png", maintainer: 'CS8ABG', loadingGif: "loading.gif", name: "WaveLog_HAMLib_Gate", setupIcon: "./icon.ico" },
		},
		{
			name: '@electron-forge/maker-dmg',
			config: { format: 'UDZO' },
			platforms: ['darwin'],
			arch: ['x64','arm64'],
		},
		{
			name: '@electron-forge/maker-deb',
			config: { "bin":"wlhlgate" },
			arch: ['x86','armv7l']
		},
	],
	plugins: [
		{
			name: '@electron-forge/plugin-auto-unpack-natives',
			config: {},
		},
	],
};
