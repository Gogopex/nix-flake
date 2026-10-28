{ ... }:
{
  home-manager.sharedModules = [
    (
      { config, ... }:
      {
        # Read inventory edits immediately; the binary contains no lab configuration.
        xdg.configFile."dispatch/config.toml".source =
          config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/dev/nix-dotfiles/cfg/dispatch/config.toml";
      }
    )
  ];
}
