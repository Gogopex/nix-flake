lib:
lib.darwinSystem' {
  imports = [
    ../profiles/darwin-ssh-target.nix
  ]
  ++ lib.optional (builtins.pathExists ../profiles/package/m4.nix) ../profiles/package/m4.nix;

  networking.hostName = "m4";
}
