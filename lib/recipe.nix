# A recipe - plain data, the JSON `vm new` writes - as a machine module, built
# from a catalog (lib/catalog.nix):
#
#   { "os": "ubuntu", "desktop": "gnome", "features": [ "git", "direnv" ],
#     "tools": [ "bun" ], "keyboard": "pt", "cpus": 4, "memory": 8192,
#     "diskSize": 20480 }
#
# Features pull in what they require (direnv on Ubuntu brings nix and zsh), and
# a combination that can't work - a feature on an OS it doesn't run on, one
# that needs a desktop on a machine without - fails with the reason, not a
# stack of module errors.
{ lib }:

catalog: recipe:

let
  os = recipe.os or (throw "recipe: no os");
  osEntry = catalog.os.${os} or (throw "recipe: unknown os '${os}'");
  # What features and desktops name: ubuntu for every Ubuntu release.
  family = osEntry.family or os;
  desktop = recipe.desktop or null;

  feature = id: catalog.features.${id} or (throw "recipe: unknown feature '${id}'");
  needs = id: let f = feature id; in (f.requires or [ ]) ++ (f.requiresOn.${family} or [ ]);
  close = ids:
    let next = lib.unique (ids ++ lib.concatMap needs ids);
    in if next == ids then ids else close next;

  # Features that are part of this OS (Nix on NixOS): on whatever the recipe says.
  builtin = lib.attrNames (lib.filterAttrs (_: f: lib.elem family (f.builtinOn or [ ])) catalog.features);

  moduleOf = id:
    let f = feature id; in
    if f ? os && !(lib.elem family f.os) then throw "recipe: ${id} doesn't run on ${os}"
    else if (f.desktop or false) && desktop == null then throw "recipe: ${id} needs a desktop"
    else f.module;

  desktopModules =
    if desktop == null then [ ]
    else
      let d = catalog.desktops.${desktop} or (throw "recipe: unknown desktop '${desktop}'"); in
      if lib.elem family d.os then [ d.module ] else throw "recipe: ${desktop} doesn't run on ${os}";

  # Sizes from the recipe win over a plugin's own (gui's 8 GiB).
  size = name: lib.optionalAttrs (recipe ? ${name}) { ${name} = lib.mkForce recipe.${name}; };
in
{ pkgs, ... }:
{
  imports = [ osEntry.base ] ++ desktopModules ++ map moduleOf (close ((recipe.features or [ ]) ++ builtin))
    ++ lib.optional (recipe ? keyboard) ../plugins/keyboard.nix;

  packages = map
    (name: lib.attrByPath (lib.splitString "." name) (throw "recipe: nixpkgs has no '${name}'") pkgs)
    (recipe.tools or [ ]);
} // size "cpus" // size "memory" // size "diskSize"
  // lib.optionalAttrs (recipe ? keyboard) { keyboard.layout = recipe.keyboard; }
