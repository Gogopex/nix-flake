lib:
lib.darwinSystem' {
  imports = [
    ../profiles/darwin-ssh-target.nix
  ]
  ++ lib.optional (builtins.pathExists ../profiles/package/macmini.nix) ../profiles/package/macmini.nix;

  networking.hostName = "macmini";
}
