{
  description = "dev env";

  nixConfig = {
    experimental-features = [
      "flakes"
      "nix-command"
      "pipe-operators"
    ];

    builders-use-substitutes = true;
    flake-registry = "";
    http-connections = 50;
    show-trace = true;
    warn-dirty = false;
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    nix-darwin = {
      url = "github:LnL7/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    agenix = {
      url = "github:ryantm/agenix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.darwin.follows = "nix-darwin";
      inputs.home-manager.follows = "home-manager";
    };

    dispatch = {
      url = "git+ssh://git@github.com/Gogopex/dispatch.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    recall = {
      url = "git+ssh://git@github.com/Gogopex/recall.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    zjstatus.url = "github:dj95/zjstatus";
  };

  outputs =
    inputs@{
      nixpkgs,
      nix-darwin,
      home-manager,
      ...
    }:
    let
      inherit (builtins) readDir;
      inherit (nixpkgs.lib)
        filterAttrs
        genAttrs
        hasSuffix
        mapAttrs'
        nameValuePair
        removeSuffix
        ;

      lib' = nixpkgs.lib.extend (_: _: nix-darwin.lib);
      lib = lib'.extend <| import ./lib inputs;

      hosts =
        readDir ./hosts
        |> filterAttrs (name: type: type == "regular" && hasSuffix ".nix" name)
        |> mapAttrs' (name: _: nameValuePair (removeSuffix ".nix" name) <| import ./hosts/${name} lib);

      darwinHomeHosts = [
        "m5m"
        "m1p"
      ];

      # Separate hosts by type
      isDarwin = _: host: host ? config && host ? system;
      isHomeManager = _: host: host ? activationPackage;

      darwinConfigurations = hosts |> lib.filterAttrs isDarwin;
      baseHomeConfigurations = hosts |> lib.filterAttrs isHomeManager;
      homeConfigurations =
        baseHomeConfigurations
        // genAttrs darwinHomeHosts (
          host:
          lib.homeManagerConfiguration' {
            system = "aarch64-darwin";
            username = "ludwig";
            homeDirectory = "/Users/ludwig";
            commonModules = [ ];
            module = import ./profiles/darwin-home.nix;
          }
        );

      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      formatter = genAttrs systems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
      inherit lib darwinConfigurations homeConfigurations;
    };
}
