using System.Text.Json;
using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;
using Mutagen.Bethesda.Environments;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Aspects;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Strings;
using Noggog;

// Rewrites AlduinakAdditions.esp with the proficiency content described by spec.json: the rank marker abilities,
// the crafting keywords, the alchemy lab and woodcrafting benches, the potion and charcoal recipes, the tier
// conditions on cooking, smithing, tempering, woodworking and tailoring recipes, the meadery boiler benches, the hidden
// and moved recipes, the few enchantment and placed reference fixes the spec names, and the writing items.
// Run through patch.py, which pre-cleans the plugin, invokes this program and verifies the result.
//   dotnet run -c Release -- --settings <server-settings.json> --plugin <precleaned AlduinakAdditions.esp> --spec <spec.json> --out <dir> [--report <dir>] [--no-creations] [--hotfix]

var opts = Cli.Parse(args);
var spec = JsonNode.Parse(File.ReadAllText(opts.Spec))!.AsObject();
var settings = JsonNode.Parse(File.ReadAllText(opts.Settings))!;
var dataDir = settings["dataDir"]!.GetValue<string>();
var creationsSpec = spec["creations"] as JsonObject;
var creationsName = creationsSpec?["pluginName"]?.GetValue<string>() ?? "";
var loadOrderNames = settings["loadOrder"]!.AsArray().Select(n => Path.GetFileName(n!.GetValue<string>()))
    .Where(n => !string.Equals(n, creationsName, StringComparison.OrdinalIgnoreCase)).ToList();
var pluginName = spec["pluginName"]?.GetValue<string>() ?? "AlduinakAdditions.esp";
var pluginKey = ModKey.FromNameAndExtension(pluginName);
var position = loadOrderNames.FindIndex(n => string.Equals(n, pluginName, StringComparison.OrdinalIgnoreCase));
if (position < 0) throw new Exception($"{pluginName} is not in the server load order");
var creationKeys = Creations.PluginKeys(creationsSpec, loadOrderNames, opts.NoCreations);

var keys = loadOrderNames.Select(n => ModKey.FromNameAndExtension(n)).ToArray();
var env = GameEnvironment.Typical.Builder<ISkyrimMod, ISkyrimModGetter>(GameRelease.SkyrimSE)
    .WithTargetDataFolder(dataDir)
    .WithStringParameters(new StringsReadParameters { StringsFolderOverride = BaseStrings.Extract(dataDir) })
    .WithLoadOrder(keys)
    .Build();
// The Creations stay out of AlduinakAdditions.esp: their recipes and overrides go to AlduinakCreations.esp
var additionsOrder = new LoadOrder<IModListingGetter<ISkyrimModGetter>>(env.LoadOrder.ListedOrder.Where(l => !creationKeys.Contains(l.ModKey)));
var cache = additionsOrder.ToImmutableLinkCache();
// The pre-cleaned copy has another file name, the records must still belong to the plugin's own key
var mod = SkyrimMod.CreateFromBinary(new ModPath(pluginKey, opts.Plugin), SkyrimRelease.SkyrimSE);
// Light (ESL-flagged) plugins share the 0xFE slot, so the plugin's full slot counts only the full plugins before it
var loadIndex = env.LoadOrder.ListedOrder.Take(position).Count(l => l.Mod != null && ((int)l.Mod.ModHeader.Flags & 0x200) == 0);
if (((int)mod.ModHeader.Flags & 0x200) != 0) throw new Exception($"{pluginName} is ESL-flagged, the global id rule below does not apply");
var report = new Report(loadIndex, pluginKey);
// A hotfix run sweeps only recipes the plugin does not override yet and none a Creation defines; the spec's named recipes are still applied
var overridden = mod.ConstructibleObjects.Select(x => x.FormKey).ToHashSet();
var creationRecipes = Creations.Named(creationsSpec);
var ctx = new PatchContext(mod, cache, additionsOrder, spec, report,
                           includes: opts.Hotfix ? r => !overridden.Contains(r.FormKey) && !creationRecipes.Contains(r.FormKey.ModKey) : null)
          { Hotfix = opts.Hotfix, CreationKeys = creationRecipes };
if (opts.NextFormId is uint pinned)
{
    // Pinned ids keep the marker spells stable for learnedSpells and server-settings.json; AddNew does not check for collisions
    var taken = mod.EnumerateMajorRecords().Where(r => r.FormKey.ModKey == pluginKey && r.FormKey.ID >= pinned && r.FormKey.ID < pinned + 0x100).Select(r => r.FormKey.ToString()).ToList();
    if (taken.Count > 0) throw new Exception($"--next-form-id {pinned:X}: own records already use {string.Join(", ", taken.Take(10))}");
    mod.ModHeader.Stats.NextFormID = pinned;
}

Console.WriteLine($"{pluginName}: position {position} in the load order, full slot {loadIndex:X2}, {mod.ModHeader.MasterReferences.Count} masters, next form id {mod.ModHeader.Stats.NextFormID:X}");

JsonObject? categories = null;
Action<PatchContext> categoriesStep = c => categories = Steps.Categories(c);
// A hotfix run adds only these steps to the live plugin, which already holds everything the others build
Action<PatchContext>[] steps = opts.Hotfix
    ? [Steps.Cooking, Steps.Smithing, Steps.Tempering, Steps.Tailoring, Steps.Factions, Steps.Uncraftable, Steps.LeveledItems, Steps.Writing,
       Steps.Racial, Steps.EnchantmentMagnitudes, Steps.Races, Steps.HeadParts, Steps.DisableReferences, Steps.Overrides, Steps.DisableActors,
       categoriesStep, Steps.MarkerEffects]
    : [Steps.Keywords, Steps.Items, Steps.MarkerAbilities, Steps.WoodcraftingBench, Steps.AlchemyLabs, Steps.AlchemyRecipes, Steps.KilnRecipes,
       Steps.Cooking, Steps.Smithing, Steps.Tempering, Steps.Tailoring, Steps.Factions, Steps.Uncraftable, Steps.LeveledItems, Steps.Meadery,
       Steps.BenchKeywordRemovals, Steps.BenchMoves, Steps.EnchantmentMagnitudes, Steps.Placements, Steps.World, Steps.Writing,
       Steps.Racial, Steps.Races, Steps.HeadParts, Steps.DisableReferences, Steps.Overrides, Steps.DisableActors, Steps.Orphans, categoriesStep,
       Steps.MarkerEffects];
foreach (var step in steps) step(ctx);

if (report.Errors.Count > 0)
{
    Console.WriteLine($"{report.Errors.Count} error(s):");
    foreach (var e in report.Errors) Console.WriteLine("  " + e);
    report.Write(opts.ReportDir, mod, env.LoadOrder, failed: true);
    return 2;
}

Directory.CreateDirectory(opts.Out);
var outPath = Path.Combine(opts.Out, pluginName);
mod.WriteToBinary(outPath, new BinaryWriteParameters
{
    MastersListContent = MastersListContentOption.Iterate,
    MastersListOrdering = new MastersListOrderingByLoadOrder(env.LoadOrder.ListedOrder.Select(l => l.ModKey)),
    ModKey = ModKeyOption.NoCheck,
    RecordCount = RecordCountOption.Iterate,
    NextFormID = NextFormIDOption.Iterate,
});
Console.WriteLine($"wrote {outPath} ({new FileInfo(outPath).Length} bytes)");
if (spec["craftingCategories"] is JsonObject cat && categories != null)
{
    var dir = Path.Combine(opts.Out, "CraftingCategories");
    Directory.CreateDirectory(dir);
    var file = Path.Combine(dir, cat["file"]!.GetValue<string>());
    File.WriteAllText(file, categories.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    Console.WriteLine($"wrote {file}; install it as SKSE/Plugins/CraftingCategories/{cat["file"]!.GetValue<string>()}");
}
report.Write(opts.ReportDir, mod, env.LoadOrder, failed: false);
if (creationKeys.Count > 0 && !opts.NoCreations && !Creations.Build(spec, creationsSpec!, env.LoadOrder.ListedOrder, mod, creationKeys, opts.Out, opts.ReportDir))
    return 2;
return 0;

// ---------------------------------------------------------------------------------------------------------------------

record Cli(string Settings, string Plugin, string Spec, string Out, string ReportDir, uint? NextFormId, bool NoCreations, bool Hotfix)
{
    public static Cli Parse(string[] args)
    {
        string? settings = null, plugin = null, spec = null, outDir = null, reportDir = null;
        uint? nextFormId = null;
        var noCreations = false;
        var hotfix = false;
        for (int i = 0; i < args.Length; i += 2)
        {
            if (args[i] == "--no-creations") { noCreations = true; i--; continue; }
            if (args[i] == "--hotfix") { hotfix = true; i--; continue; }
            if (i + 1 >= args.Length) throw new Exception($"option {args[i]} needs a value");
            switch (args[i])
            {
                case "--settings": settings = args[i + 1]; break;
                case "--plugin": plugin = args[i + 1]; break;
                case "--spec": spec = args[i + 1]; break;
                case "--out": outDir = args[i + 1]; break;
                case "--report": reportDir = args[i + 1]; break;
                case "--next-form-id": nextFormId = Convert.ToUInt32(args[i + 1], 16); break;
                default: throw new Exception($"unknown option {args[i]}");
            }
        }
        if (settings == null || plugin == null || spec == null || outDir == null)
            throw new Exception("usage: --settings <server-settings.json> --plugin <AlduinakAdditions.esp> --spec <spec.json> --out <dir> [--report <dir>] [--next-form-id <hex>] [--no-creations] [--hotfix]");
        return new Cli(settings, plugin, spec, outDir, reportDir ?? outDir, nextFormId, noCreations, hotfix);
    }
}

// Mutagen reads only Skyrim.esm's strings from Skyrim - Interface.bsa, where the DLC masters keep theirs as well
static class BaseStrings
{
    public static string? Extract(string dataDir)
    {
        var bsa = Path.Combine(dataDir, "Skyrim - Interface.bsa");
        if (!File.Exists(bsa)) return null;
        var dir = Path.Combine(Path.GetTempPath(), "proficiency-patcher-strings");
        Directory.CreateDirectory(dir);
        foreach (var f in Archive.CreateReader(GameRelease.SkyrimSE, bsa).Files)
        {
            var path = f.Path.Replace('\\', '/');
            if (path.StartsWith("strings/", StringComparison.OrdinalIgnoreCase))
                File.WriteAllBytes(Path.Combine(dir, Path.GetFileName(path)), f.GetBytes());
        }
        return dir;
    }
}

class PatchContext
{
    public readonly SkyrimMod Mod;
    public readonly ILinkCache Cache;
    public readonly ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> LoadOrder;
    public readonly JsonObject Spec;
    public readonly Report Report;
    public readonly ModKey Key;
    // Plugin holding the AldMastery_ marker spells the tier conditions point at
    public readonly ModKey MarkerKey;
    // Winning recipes the loops over the load order may tier
    public readonly Func<IMajorRecordGetter, bool> Includes;
    // Editor id -> record already in the mutable plugin (own records and overrides), refreshed as records are added.
    private readonly Dictionary<string, IMajorRecord> ownByEdid = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<FormKey, int>? materialTiers;
    private Dictionary<string, Route>? routes;
    // Recipes a faction rule gated, which the uncraftable list must then leave alone
    public readonly HashSet<string> Claimed = new(StringComparer.OrdinalIgnoreCase);

    public PatchContext(SkyrimMod mod, ILinkCache cache, ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> loadOrder, JsonObject spec, Report report,
                        ModKey? markerKey = null, Func<IMajorRecordGetter, bool>? includes = null)
    {
        Mod = mod; Cache = cache; LoadOrder = loadOrder; Spec = spec; Report = report; Key = mod.ModKey;
        MarkerKey = markerKey ?? mod.ModKey;
        Includes = includes ?? (_ => true);
        foreach (var rec in mod.EnumerateMajorRecords())
            if (!string.IsNullOrEmpty(rec.EditorID)) ownByEdid[rec.EditorID] = rec;
    }

    // The pseudo-tier of a recipe no profession owns: SetTier writes no marker condition for it.
    public const string AnyoneTier = "Anyone";
    public bool Hotfix { get; init; }
    // Plugins of the Creation Club recipes: faction rules leave them alone unless they say "creations", race rules always do
    public HashSet<ModKey> CreationKeys { get; init; } = new();
    public string[] Ranks => Spec["ranks"]!.AsArray().Select(r => r!.GetValue<string>()).ToArray();
    public Dictionary<FormKey, int> MaterialTiers => materialTiers ??= Steps.MaterialTiers(this);
    // Recipe editor id -> the bench and profession the routing rules give it
    public Dictionary<string, Route> Routes => routes ??= Steps.Routes(this);
    public IEnumerable<KeyValuePair<string, string>> Professions => Spec["professions"]!.AsObject().Select(p => new KeyValuePair<string, string>(p.Key, p.Value!.GetValue<string>()));

    public string MarkerEdid(string profession, string rank) => $"AldMastery_{Cap(profession)}_{rank}";
    public static string Cap(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s.Substring(1);

    // Winning record of the load order by editor id, of a given type.
    public bool TryWinning<T>(string edid, out T rec) where T : class, IMajorRecordGetter
    {
        if (ownByEdid.TryGetValue(edid, out var own) && own is T ownT) { rec = ownT; return true; }
        if (Cache.TryResolve<T>(edid, out var found)) { rec = found; return true; }
        rec = null!;
        return false;
    }

    public T Winning<T>(string edid) where T : class, IMajorRecordGetter
    {
        if (TryWinning<T>(edid, out var rec)) return rec;
        throw new SpecException($"{typeof(T).Name} '{edid}' not found in the load order");
    }

    public FormKey KeyOf<T>(string edid) where T : class, IMajorRecordGetter => Winning<T>(edid).FormKey;

    // Own record by editor id, created when missing (idempotent re-runs reuse it).
    // formId pins the record's local id, for the few the client names by "<hex>:<plugin>".
    public T OwnOrNew<T>(IGroup<T> group, string edid, Action<T>? init = null, uint? formId = null) where T : class, IMajorRecord =>
        OwnOrNew(edid, () => formId is uint id ? AddAt(group, edid, id) : group.AddNew(edid), init);

    T AddAt<T>(IGroup<T> group, string edid, uint id) where T : class, IMajorRecord
    {
        var key = new FormKey(Key, id);
        if (Mod.EnumerateMajorRecords().Any(r => r.FormKey == key))
            throw new SpecException($"'{edid}' wants the pinned id {key}, which another record already holds");
        var rec = group.AddNew(key);
        rec.EditorID = edid;
        return rec;
    }

    // Same for records outside a top-level group, such as placed references; create adds the record to its container
    public T OwnOrNew<T>(string edid, Func<T> create, Action<T>? init = null) where T : class, IMajorRecord
    {
        if (ownByEdid.TryGetValue(edid, out var existing))
        {
            if (existing is T t && t.FormKey.ModKey == Key) return t;
            throw new SpecException($"'{edid}' already exists in {Key} as {existing.GetType().Name}, not as a new {typeof(T).Name}");
        }
        if (Cache.TryResolveIdentifier(edid, out var clash) && clash.ModKey != Key)
            throw new SpecException($"editor id '{edid}' is already used by {clash}");
        var rec = create();
        init?.Invoke(rec);
        ownByEdid[edid] = rec;
        Report.NewRecords.Add($"{rec.Registration.Name} {edid} {rec.FormKey}");
        return rec;
    }

    // Override of a winning record, added to the plugin when it is not already overridden there.
    public T Override<T, TGetter>(IGroup<T> group, TGetter winning) where T : class, IMajorRecordInternal, TGetter where TGetter : class, IMajorRecordGetter
    {
        var rec = group.GetOrAddAsOverride(winning);
        if (!string.IsNullOrEmpty(rec.EditorID)) ownByEdid[rec.EditorID] = rec;
        return rec;
    }

    public void Error(string msg) => Report.Errors.Add(msg);
    public void Note(string msg) => Report.Notes.Add(msg);
    public void Warn(string msg) => Report.Warnings.Add(msg);
}

class SpecException : Exception { public SpecException(string m) : base(m) { } }

static class Steps
{
    // ---- keywords ----------------------------------------------------------------------------------------------
    public static void Keywords(PatchContext c)
    {
        foreach (var kv in c.Spec["keywords"]!.AsObject())
            c.OwnOrNew(c.Mod.Keywords, kv.Value!.GetValue<string>());
    }

    // ---- marker abilities: one Ability spell per profession and rank, carrying that rank's vanilla perks ---------
    public static void MarkerAbilities(PatchContext c)
    {
        var abilities = c.Spec["abilities"]?.AsObject();
        foreach (var (profId, label) in c.Professions)
        {
            foreach (var rank in c.Ranks)
            {
                var edid = c.MarkerEdid(profId, rank);
                var spell = c.OwnOrNew(c.Mod.Spells, edid);
                spell.Name = $"{label}: {rank}";
                spell.Type = SpellType.Ability;
                spell.CastType = CastType.ConstantEffect;
                spell.TargetType = TargetType.Self;
                spell.CastDuration = 0;
                spell.ChargeTime = 0;
                spell.BaseCost = 0;
                spell.Flags = SpellDataFlag.ManualCostCalc;
                spell.EquipmentType.Clear();
                spell.Effects.Clear();
                spell.Description = $"Rank of {rank} in the craft of the {label}.";

                var rankSpec = abilities?[profId]?[rank]?.AsObject();
                if (rankSpec == null) continue;
                // "perks": ["QuickShot", {"edid": "DualFlurry30", "untilRank": "Master"}]; a perk with untilRank switches off once that rank's marker is held
                foreach (var entry in rankSpec["perks"]?.AsArray() ?? new JsonArray())
                {
                    var perkEdid = entry is JsonObject po ? po["edid"]!.GetValue<string>() : entry!.GetValue<string>();
                    var untilRank = entry is JsonObject po2 ? po2["untilRank"]?.GetValue<string>() : null;
                    if (!c.TryWinning<IPerkGetter>(perkEdid, out var perk)) { c.Error($"perk '{perkEdid}' for {edid} not found"); continue; }
                    var mgef = c.OwnOrNew(c.Mod.MagicEffects, $"AldMasteryPerk_{perkEdid}");
                    ConfigureMgef(mgef, $"{perk.Name?.String ?? perkEdid}", perk.Description?.String ?? "");
                    mgef.Archetype = new MagicEffectArchetype { Type = MagicEffectArchetype.TypeEnum.Script, ActorValue = ActorValue.None };
                    mgef.PerkToApply.SetTo(perk.FormKey);
                    var effect = new Effect { BaseEffect = mgef.ToNullableLink(), Data = new EffectData { Magnitude = 0, Area = 0, Duration = 0 } };
                    if (untilRank != null)
                    {
                        if (Array.IndexOf(c.Ranks, untilRank) < 0) { c.Error($"{edid}: unknown untilRank '{untilRank}'"); continue; }
                        var higher = c.OwnOrNew(c.Mod.Spells, c.MarkerEdid(profId, untilRank));
                        var data = new HasSpellConditionData { RunOnType = Condition.RunOnType.Subject };
                        data.Spell.Link.SetTo(higher.FormKey);
                        effect.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.EqualTo, ComparisonValue = 0f, Data = data });
                    }
                    spell.Effects.Add(effect);
                }
                var stamina = rankSpec["stamina"]?.GetValue<float>() ?? 0;
                if (stamina > 0)
                {
                    var mgef = c.OwnOrNew(c.Mod.MagicEffects, "AldMasteryFortifyStamina");
                    ConfigureMgef(mgef, "Fortify Stamina", "Stamina is increased by <mag> points.");
                    mgef.Archetype = new MagicEffectArchetype { Type = MagicEffectArchetype.TypeEnum.ValueModifier, ActorValue = ActorValue.Stamina };
                    mgef.Flags = (mgef.Flags & ~MagicEffect.Flag.NoMagnitude) | MagicEffect.Flag.Recover;
                    mgef.PerkToApply.SetToNull();
                    spell.Effects.Add(new Effect { BaseEffect = mgef.ToNullableLink(), Data = new EffectData { Magnitude = stamina, Area = 0, Duration = 0 } });
                }
            }
        }
    }

    // ---- marker effects: an ability with no effect at all is an invalid record ------------------------------------
    //
    // Runs last: a new own record takes the next free local id, and the marker ids are named from outside the plugin
    // (server-settings damageMultConditionalFormulaSettings holds AldMastery_Hunter_Master).
    public static void MarkerEffects(PatchContext c)
    {
        var empty = c.Mod.Spells.Where(s => s.Effects.Count == 0).ToList();
        if (empty.Count == 0) return;
        var mgef = c.OwnOrNew(c.Mod.MagicEffects, "AldMasteryMarkerEffect");
        ConfigureMgef(mgef, "Mastery", "A mark of what this character has learned.");
        mgef.Archetype = new MagicEffectArchetype { Type = MagicEffectArchetype.TypeEnum.Script, ActorValue = ActorValue.None };
        mgef.PerkToApply.SetToNull();
        foreach (var spell in empty)
            spell.Effects.Add(new Effect { BaseEffect = mgef.ToNullableLink(), Data = new EffectData { Magnitude = 0, Area = 0, Duration = 0 } });
        c.Note($"Marker effect: {empty.Count} markers with no perk of their own carry the inert {mgef.EditorID}");
    }

    static void ConfigureMgef(MagicEffect mgef, string name, string description)
    {
        mgef.Name = name;
        mgef.Description = description;
        mgef.CastType = CastType.ConstantEffect;
        mgef.TargetType = TargetType.Self;
        mgef.MagicSkill = ActorValue.None;
        mgef.ResistValue = ActorValue.None;
        mgef.MinimumSkillLevel = 0;
        mgef.BaseCost = 0;
        mgef.Flags = MagicEffect.Flag.HideInUI | MagicEffect.Flag.NoHitEvent | MagicEffect.Flag.NoDuration | MagicEffect.Flag.NoArea | MagicEffect.Flag.NoMagnitude;
        mgef.Conditions.Clear();
    }

    // ---- woodcrafting bench: a new bench from the Hearthfire carpenter's workbench, and the existing ones tagged ---
    public static void WoodcraftingBench(PatchContext c)
    {
        var w = c.Spec["woodcraftingBench"]!.AsObject();
        var kw = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["woodcrafting"]!.GetValue<string>());
        NewBench(c, w["template"]!.GetValue<string>(), w["edid"]!.GetValue<string>(), w["name"]!.GetValue<string>(), w["removeKeywords"]?.AsArray(), new[] { kw });

        foreach (var tagEdid in w["alsoTag"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>())
        {
            if (!c.TryWinning<IFurnitureGetter>(tagEdid, out var winning)) { c.Warn($"woodcrafting: bench '{tagEdid}' not found, skipped"); continue; }
            var furn = c.Override(c.Mod.Furniture, winning);
            furn.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
            if (!furn.Keywords.Any(x => x.FormKey == kw)) furn.Keywords.Add(kw.ToLink<IKeywordGetter>());
            c.Note($"Woodcrafting: {tagEdid} also offers woodcrafting recipes");
        }
    }

    // A crafting bench copied from a template furniture, the template's listed keywords swapped for the bench keywords
    static Furniture NewBench(PatchContext c, string templateEdid, string edid, string name, JsonArray? removeKeywords, IEnumerable<FormKey> keywords)
    {
        var template = c.Winning<IFurnitureGetter>(templateEdid);
        var bench = c.OwnOrNew(c.Mod.Furniture, edid);
        var key = bench.FormKey;
        bench.DeepCopyIn(template);
        bench.EditorID = edid;
        // Template scripts (the Hearthfire bench builds house parts) have no place on a plain crafting bench
        bench.VirtualMachineAdapter = null;
        bench.Name = name;
        bench.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
        var drop = (removeKeywords?.Select(x => c.KeyOf<IKeywordGetter>(x!.GetValue<string>())) ?? Enumerable.Empty<FormKey>()).ToHashSet();
        bench.Keywords.RemoveAll(x => drop.Contains(x.FormKey));
        foreach (var kw in keywords)
            if (!bench.Keywords.Any(x => x.FormKey == kw)) bench.Keywords.Add(kw.ToLink<IKeywordGetter>());
        bench.WorkbenchData ??= new WorkbenchData();
        bench.WorkbenchData.BenchType = WorkbenchData.Type.CreateObject;
        bench.WorkbenchData.UsesSkill = null;
        if (bench.FormKey != key) throw new Exception("form key changed by DeepCopyIn");
        c.Note($"Bench {edid} {key} created from {template.EditorID} with {string.Join(", ", bench.Keywords.Select(x => c.Mod.Keywords.TryGetValue(x.FormKey)?.EditorID ?? c.EdidOf(x.FormKey)))}");
        return bench;
    }

    // ---- alchemy labs open the crafting menu instead of the alchemy menu -------------------------------------------
    public static void AlchemyLabs(PatchContext c)
    {
        var kw = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["alchemy"]!.GetValue<string>());
        foreach (var edid in c.Spec["alchemyLabs"]!.AsArray().Select(x => x!.GetValue<string>()))
        {
            if (!c.TryWinning<IFurnitureGetter>(edid, out var winning)) { c.Warn($"alchemy lab '{edid}' not found, skipped"); continue; }
            var furn = c.Override(c.Mod.Furniture, winning);
            furn.WorkbenchData ??= new WorkbenchData();
            furn.WorkbenchData.BenchType = WorkbenchData.Type.CreateObject;
            furn.WorkbenchData.UsesSkill = null;
            furn.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
            if (!furn.Keywords.Any(x => x.FormKey == kw)) furn.Keywords.Add(kw.ToLink<IKeywordGetter>());
            c.Note($"Alchemy lab {edid}: crafting menu with keyword {c.EdidOf(kw)}");
        }
    }

    // ---- potion, drink, poison and salt recipes at the alchemy lab ---------------------------------------------------
    public static void AlchemyRecipes(PatchContext c)
    {
        var bench = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["alchemy"]!.GetValue<string>());
        var profession = c.Spec["alchemy"]!["profession"]!.GetValue<string>();
        foreach (var r in c.Spec["alchemy"]!["recipes"]!.AsArray().Select(x => x!.AsObject()))
            NewRecipe(c, r, bench, profession, "AldRecipeAlchemy_");
    }

    // A kiln recipe may name its own bench; the kiln keyword is the fallback until a kiln furniture exists
    public static void KilnRecipes(PatchContext c)
    {
        var fallback = c.Spec["keywords"]!["kiln"]!.GetValue<string>();
        foreach (var r in c.Spec["kilnRecipes"]!.AsArray().Select(x => x!.AsObject()))
            NewRecipe(c, r, c.KeyOf<IKeywordGetter>(r["bench"]?.GetValue<string>() ?? fallback), r["profession"]?.GetValue<string>(), "AldRecipeKiln_");
    }

    // The server's mastery system credits no hours for recipes under this prefix
    const string CommonRecipePrefix = "AldRecipeCommon_";

    // A recipe without a profession is a common one: Anyone, so every character makes it, and named for the mastery exemption
    static void NewRecipe(PatchContext c, JsonObject r, FormKey bench, string? profession, string prefix)
    {
        var outputEdid = r["output"]!.GetValue<string>();
        if (!c.TryWinning<IMajorRecordGetter>(outputEdid, out var output)) { c.Error($"recipe output '{outputEdid}' not found"); return; }
        var edid = r["edid"]?.GetValue<string>() ?? (profession == null ? CommonRecipePrefix : prefix) + outputEdid;
        if (profession == null && (r["tier"]!.GetValue<string>() != PatchContext.AnyoneTier || !edid.StartsWith(CommonRecipePrefix)))
            throw new SpecException($"recipe {edid}: a recipe without a profession must be {PatchContext.AnyoneTier} and named {CommonRecipePrefix}*");
        // A pinned id keeps a recipe added later out of the block a hotfix run allocates in order, so the records after it keep their ids
        var cobj = c.OwnOrNew(c.Mod.ConstructibleObjects, edid, formId: r["formId"] is JsonNode pin ? Convert.ToUInt32(pin.GetValue<string>(), 16) : null);
        cobj.WorkbenchKeyword.SetTo(bench);
        cobj.CreatedObject.SetTo(output.FormKey);
        cobj.CreatedObjectCount = (ushort)(r["count"]?.GetValue<int>() ?? 1);
        cobj.Items = new ExtendedList<ContainerEntry>();
        foreach (var item in r["items"]!.AsObject())
        {
            if (!c.TryWinning<IMajorRecordGetter>(item.Key, out var ing)) { c.Error($"recipe {edid}: ingredient '{item.Key}' not found"); continue; }
            cobj.Items.Add(new ContainerEntry { Item = new ContainerItem { Item = ing.FormKey.ToLink<IItemGetter>(), Count = item.Value!.GetValue<int>() } });
        }
        SetTier(c, cobj, profession ?? "", r["tier"]!.GetValue<string>());
        c.Report.Recipes.Add(new RecipeLine(profession == null ? "common" : Kind(prefix), edid, c.NameOf(output.FormKey), profession ?? "any", r["tier"]!.GetValue<string>(), cobj.Items.Select(i => $"{i.Item.Count}x {c.NameOf(i.Item.Item.FormKey)}").ToList(),
                                           note: profession == null ? "no mastery hours" : null));
    }

    static string Kind(string prefix) => prefix switch
    {
        "AldRecipeKiln_" => "kiln",
        "AldRecipeWriting_" => "writing",
        "AldRecipeSmith_" => "smithing",
        "AldRecipeWood_" => "woodworking",
        "AldRecipeTailor_" => "tailoring",
        "AldRecipeMead_" => "mead",
        "AldRecipeCook_" => "cooking",
        _ => "alchemy",
    };

    // ---- cooking: vanilla recipes kept, meats need salt, tiers by the owner's list ----------------------------------
    public static void Cooking(PatchContext c)
    {
        var cook = c.Spec["cooking"]!.AsObject();
        var profession = cook["profession"]!.GetValue<string>();
        var salt = c.KeyOf<IMajorRecordGetter>(cook["saltItem"]!.GetValue<string>());
        var needsSalt = cook["needsSalt"]!.AsArray().Select(x => x!.GetValue<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var tierOf = TierMap(cook["tiers"]!.AsObject());
        var benches = cook["benches"]!.AsArray().Select(x => c.KeyOf<IKeywordGetter>(x!.GetValue<string>())).ToHashSet();
        var strip = cook["stripConditions"]?.GetValue<bool>() == true ? StripSet(c, true) : new HashSet<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey) || !c.Includes(winning)) continue;
            var edid = winning.EditorID ?? "";
            seen.Add(edid);
            var tier = tierOf.GetValueOrDefault(edid, "Novice");
            var addSalt = needsSalt.Contains(edid) && !(winning.Items ?? new List<IContainerEntryGetter>()).Any(i => i.Item.Item.FormKey == salt);
            var stripped = winning.Conditions.Any(cond => strip.Contains(FunctionOf(cond)));
            if (tier == PatchContext.AnyoneTier && !addSalt && !stripped && !HasAldCondition(c, winning)) { c.Report.Recipes.Add(new RecipeLine("cooking", edid, c.NameOf(winning.CreatedObject.FormKey), profession, tier, Items(c, winning), untouched: true)); continue; }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            cobj.Items ??= new ExtendedList<ContainerEntry>();
            if (addSalt) cobj.Items.Add(new ContainerEntry { Item = new ContainerItem { Item = salt.ToLink<IItemGetter>(), Count = 1 } });
            cobj.Conditions.RemoveAll(cond => strip.Contains(FunctionOf(cond)));
            SetTier(c, cobj, profession, tier);
            c.Report.Recipes.Add(new RecipeLine("cooking", edid, c.NameOf(cobj.CreatedObject.FormKey), profession, tier, Items(c, cobj), salted: addSalt, gatesStripped: stripped));
        }
        foreach (var edid in tierOf.Keys.Concat(needsSalt).Where(e => !seen.Contains(e) && !c.Hotfix))
            c.Error($"cooking: recipe '{edid}' is not a winning cooking recipe in the load order");
    }

    // ---- routing: a forge recipe belongs at the bench its materials come from -------------------------------------
    //
    // Bows, arrows, bolts and shields are the woodworker's whatever they are made of; everything else follows the
    // first material rule it matches, so ore keeps a recipe at the forge, leather and pelts send it to the tanning
    // rack and firewood to the woodcrafting bench. A recipe that takes a finished piece of gear and gives another
    // (the closed helmets, the silver upgrades) is a conversion and stays where it is; anything left over is hidden.
    public static Dictionary<string, Route> Routes(PatchContext c)
    {
        var r = c.Spec["benchRouting"]!.AsObject();
        var product = r["products"]!.AsArray().Select(x => x!.AsObject())
            .Select(x => (Rule: new Route(c.KeyOf<IKeywordGetter>(x["bench"]!.GetValue<string>()), x["bench"]!.GetValue<string>(), x["profession"]!.GetValue<string>()),
                          Keywords: Edids(c, x["keywords"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet(),
                          Kinds: Edids(c, x["kinds"]).ToHashSet(StringComparer.OrdinalIgnoreCase))).ToList();
        var material = r["materials"]!.AsArray().Select(x => x!.AsObject())
            .Select(x => (Rule: x["keep"]?.GetValue<bool>() == true ? null : new Route(c.KeyOf<IKeywordGetter>(x["bench"]!.GetValue<string>()), x["bench"]!.GetValue<string>(), x["profession"]!.GetValue<string>()),
                          Profession: x["profession"]!.GetValue<string>(),
                          Items: Edids(c, x["items"]).Select(c.KeyOf<IMajorRecordGetter>).ToHashSet(),
                          Keywords: Edids(c, x["itemKeywords"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet())).ToList();
        var conversion = r["conversions"]!["profession"]!.GetValue<string>();
        // Recipes the rules cannot read from their materials, named outright
        var named = (r["recipes"] as JsonObject ?? new JsonObject()).ToDictionary(
            kv => kv.Key,
            kv => new Route(c.KeyOf<IKeywordGetter>(kv.Value!["bench"]!.GetValue<string>()),
                            kv.Value!["bench"]!.GetValue<string>(), kv.Value!["profession"]!.GetValue<string>()),
            StringComparer.OrdinalIgnoreCase);
        var benches = Edids(c, r["from"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
        var routes = new Dictionary<string, Route>(StringComparer.OrdinalIgnoreCase);
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey) || !c.Includes(winning)) continue;
            var edid = winning.EditorID ?? "";
            if (named.TryGetValue(edid, out var forcedRoute)) { routes[edid] = forcedRoute; continue; }
            var made = ProductKeywords(c, winning.CreatedObject.FormKey, out var kind);
            var hit = product.FirstOrDefault(p => p.Kinds.Contains(kind) || made.Overlaps(p.Keywords));
            if (hit.Rule != null) { routes[edid] = hit.Rule; continue; }
            var inputs = (winning.Items ?? new List<IContainerEntryGetter>()).Select(i => i.Item.Item.FormKey).ToList();
            var by = material.FirstOrDefault(m => inputs.Any(i => m.Items.Contains(i) || ItemKeywords(c, i).Overlaps(m.Keywords)));
            if (by.Profession != null) { routes[edid] = by.Rule ?? new Route(winning.WorkbenchKeyword.FormKey, c.EdidOf(winning.WorkbenchKeyword.FormKey), by.Profession); continue; }
            // A conversion of finished gear keeps its bench; nothing else belongs at a forge
            var parking = c.Spec["uncraftable"]!["bench"]!.GetValue<string>();
            routes[edid] = inputs.Any(i => IsGear(c, i))
                ? new Route(winning.WorkbenchKeyword.FormKey, c.EdidOf(winning.WorkbenchKeyword.FormKey), conversion)
                : new Route(c.KeyOf<IKeywordGetter>(parking), parking, conversion, Hidden: true);
        }
        return routes;
    }

    static IEnumerable<string> Edids(PatchContext c, JsonNode? list) =>
        (list as JsonArray)?.Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>();

    // The keywords of a created object, with the coarse kind the product rules match on
    static HashSet<FormKey> ProductKeywords(PatchContext c, FormKey key, out string kind)
    {
        kind = c.Cache.TryResolve<IAmmunitionGetter>(key, out _) ? "ammo"
             : c.Cache.TryResolve<IArmorGetter>(key, out _) ? "armor"
             : c.Cache.TryResolve<IWeaponGetter>(key, out _) ? "weapon" : "";
        return ItemKeywords(c, key);
    }

    // IKeywordedGetter is not a lookup type of its own; the record is resolved and then asked
    static bool IsGear(PatchContext c, FormKey key) =>
        c.Cache.TryResolve<IArmorGetter>(key, out _) || c.Cache.TryResolve<IWeaponGetter>(key, out _);

    static HashSet<FormKey> ItemKeywords(PatchContext c, FormKey key) =>
        c.Cache.TryResolve<IMajorRecordGetter>(key, out var rec) && rec is IKeywordedGetter { Keywords: { } kws }
            ? kws.Select(x => x.FormKey).ToHashSet() : new HashSet<FormKey>();

    // ---- smithing: recipes routed to their bench and tiered by the highest material used --------------------------
    public static void Smithing(PatchContext c)
    {
        var s = c.Spec["smithing"]!.AsObject();
        var profession = s["profession"]!.GetValue<string>();
        var benches = s["benches"]!.AsArray().Select(x => c.KeyOf<IKeywordGetter>(x!.GetValue<string>())).ToHashSet();
        var exclude = (s["exclude"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var forced = TierMap(s["tiers"]?.AsObject() ?? new JsonObject());
        var ranks = c.Ranks;
        var strip = StripSet(c, s["stripPerkConditions"]?.GetValue<bool>() ?? true);
        var addItems = s["addItems"]?.AsObject() ?? new JsonObject();
        var extended = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in s["newRecipes"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
            NewRecipe(c, r, c.KeyOf<IKeywordGetter>(r["bench"]!.GetValue<string>()), r["profession"]?.GetValue<string>() ?? profession, "AldRecipeSmith_");
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey) || !c.Includes(winning)) continue;
            var edid = winning.EditorID ?? "";
            if (exclude.Contains(edid)) continue;
            // Smelter recipes are not routed: they are how ore becomes metal in the first place
            var route = c.Routes.GetValueOrDefault(edid);
            var owner = route?.Profession ?? profession;
            var moved = route != null && route.Bench != winning.WorkbenchKeyword.FormKey;
            // A forced tier may be Anyone, which is no rank at all
            var tier = route?.Hidden == true ? "disabled"
                     : forced.TryGetValue(edid, out var forcedTier) ? forcedTier
                     : ranks[MaterialTierOf(winning, c.MaterialTiers)];
            var stripped = winning.Conditions.Any(cond => strip.Contains(FunctionOf(cond)));
            var extra = addItems[edid]?.AsObject();
            if (extra != null) extended.Add(edid);
            if (tier == PatchContext.AnyoneTier && extra == null && !moved && !stripped && !HasAldCondition(c, winning))
            {
                c.Report.Recipes.Add(new RecipeLine("smithing", edid, c.NameOf(winning.CreatedObject.FormKey), owner, tier, Items(c, winning), untouched: true, origin: winning.FormKey.ModKey.FileName));
                continue;
            }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            AddItems(c, cobj, extra);
            cobj.Conditions.RemoveAll(cond => strip.Contains(FunctionOf(cond)));
            if (route != null) cobj.WorkbenchKeyword.SetTo(route.Bench);
            SetTier(c, cobj, owner, route?.Hidden == true ? PatchContext.AnyoneTier : tier);
            c.Report.Recipes.Add(new RecipeLine("smithing", edid, c.NameOf(cobj.CreatedObject.FormKey), owner, tier, Items(c, cobj), gatesStripped: stripped, origin: winning.FormKey.ModKey.FileName,
                                                note: route?.Hidden == true ? "makes nothing of ore, hidden" : moved ? $"moved to {route!.BenchEdid}" : null));
        }
        foreach (var (edid, _) in addItems.Where(kv => !extended.Contains(kv.Key) && !c.Hotfix))
            c.Error($"smithing: addItems recipe '{edid}' is not a winning smithing recipe in the load order");
    }

    // Ingredients an existing recipe should also cost; one the recipe already lists is left as it stands
    static void AddItems(PatchContext c, ConstructibleObject cobj, JsonObject? extra)
    {
        if (extra == null) return;
        cobj.Items ??= new ExtendedList<ContainerEntry>();
        foreach (var (name, count) in extra)
        {
            var item = c.KeyOf<IMajorRecordGetter>(name);
            if (cobj.Items.Any(i => i.Item.Item.FormKey == item)) continue;
            cobj.Items.Add(new ContainerEntry { Item = new ContainerItem { Item = item.ToLink<IItemGetter>(), Count = count?.GetValue<int>() ?? 1 } });
        }
    }

    // ---- tempering: the Improve tab follows the same material table, vanilla conditions kept ----------------------
    public static void Tempering(PatchContext c)
    {
        var s = c.Spec["smithing"]!.AsObject();
        var profession = s["profession"]!.GetValue<string>();
        var benches = (s["temperBenches"]?.AsArray().Select(x => c.KeyOf<IKeywordGetter>(x!.GetValue<string>())) ?? Enumerable.Empty<FormKey>()).ToHashSet();
        var crafter = CrafterOfProduct(c);
        var ranks = c.Ranks;
        // Improve entries the material table cannot place, named with their profession and tier; a hotfix run applies them too
        var named = (s["temperRecipes"] as JsonArray ?? new JsonArray()).Select(x => x!.AsObject())
            .ToDictionary(r => r["edid"]!.GetValue<string>(), r => r, StringComparer.OrdinalIgnoreCase);
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey) || !c.Includes(winning)) continue;
            var edid = winning.EditorID ?? "";
            if (named.ContainsKey(edid)) continue;
            var tier = ranks[MaterialTierOf(winning, c.MaterialTiers)];
            var marker = crafter.GetValueOrDefault(winning.CreatedObject.FormKey, profession);
            if (tier == PatchContext.AnyoneTier && !HasAldCondition(c, winning))
            {
                c.Report.Recipes.Add(new RecipeLine("tempering", edid, c.NameOf(winning.CreatedObject.FormKey), marker, tier, Items(c, winning), untouched: true, origin: winning.FormKey.ModKey.FileName));
                continue;
            }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            SetTier(c, cobj, marker, tier);
            c.Report.Recipes.Add(new RecipeLine("tempering", edid, c.NameOf(cobj.CreatedObject.FormKey), marker, tier, Items(c, cobj), origin: winning.FormKey.ModKey.FileName,
                                                note: marker == profession ? null : $"{marker} rank"));
        }
        foreach (var (edid, r) in named)
        {
            if (!c.TryWinning<IConstructibleObjectGetter>(edid, out var winning)) { c.Error($"tempering: recipe '{edid}' not found"); continue; }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            var owner = r["profession"]!.GetValue<string>();
            var tier = r["tier"]!.GetValue<string>();
            SetTier(c, cobj, owner, tier);
            c.Report.Recipes.Add(new RecipeLine("tempering", edid, c.NameOf(cobj.CreatedObject.FormKey), owner, tier, Items(c, cobj), origin: winning.FormKey.ModKey.FileName, note: "named"));
        }
    }

    // Product -> the profession that makes it, so a temper entry asks for the rank that made the item
    static Dictionary<FormKey, string> CrafterOfProduct(PatchContext c)
    {
        var map = new Dictionary<FormKey, string>();
        foreach (var (edid, route) in c.Routes)
            if (c.TryWinning<IConstructibleObjectGetter>(edid, out var recipe)) map[recipe.CreatedObject.FormKey] = route.Profession;
        var t = c.Spec["tailoring"]!.AsObject();
        var own = t["recipes"]!.AsArray().Where(r => r!["profession"] != null)
            .ToDictionary(r => r!["edid"]!.GetValue<string>(), r => r!["profession"]!.GetValue<string>(), StringComparer.OrdinalIgnoreCase);
        foreach (var edid in TailoringSet(c))
            if (c.TryWinning<IConstructibleObjectGetter>(edid, out var recipe)) map[recipe.CreatedObject.FormKey] = own.GetValueOrDefault(edid, t["profession"]!.GetValue<string>());
        return map;
    }

    // ---- recipes that must never be craftable: parked on a keyword no furniture carries ---------------------------
    public static void Uncraftable(PatchContext c)
    {
        if (c.Spec["uncraftable"] is not JsonObject u) return;
        // A faction rule claiming a recipe releases it: it is gated by membership now, not hidden
        var named = u["recipes"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        // Whole families are easier named by what they make; a recipe a faction already gates is not hidden
        var match = Edids(c, u["match"]).ToList();
        var except = Edids(c, u["except"]).ToList();
        if (match.Count > 0)
        {
            var benches = Edids(c, u["matchBenches"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
            foreach (var (key, cobj) in FinalRecipes(c))
            {
                if (!benches.Contains(cobj.Bench) || c.Claimed.Contains(cobj.Edid) || named.Contains(cobj.Edid)) continue;
                var made = c.Cache.TryResolve<IMajorRecordGetter>(cobj.Product, out var m) ? m : null;
                var text = $"{cobj.Edid}|{made?.EditorID}|{c.NameOf(cobj.Product)}";
                if (match.Any(x => text.Contains(x, StringComparison.OrdinalIgnoreCase))
                    && !except.Any(x => text.Contains(x, StringComparison.OrdinalIgnoreCase))) named.Add(cobj.Edid);
            }
        }
        Park(c, named.Where(e => !c.Claimed.Contains(e)), c.KeyOf<IKeywordGetter>(u["bench"]!.GetValue<string>()),
             "uncraftable", u["profession"]!.GetValue<string>());
    }

    // Only the bench keyword changes, so a recipe keeps the tier an earlier step gave it
    static void Park(PatchContext c, IEnumerable<string> edids, FormKey bench, string kind, string profession,
                     string tier = "disabled", string note = "bench set to the parking keyword, recipe hidden")
    {
        foreach (var edid in edids)
        {
            if (!c.TryWinning<IConstructibleObjectGetter>(edid, out var winning)) { c.Error($"{kind}: recipe '{edid}' not found"); continue; }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            cobj.WorkbenchKeyword.SetTo(bench);
            c.Report.Recipes.Add(new RecipeLine(kind, edid, c.NameOf(cobj.CreatedObject.FormKey), profession, tier, Items(c, cobj), origin: winning.FormKey.ModKey.FileName, note: note));
        }
    }

    // ---- leveled items: the NPC loot lists the server rolls, re-weighted, trimmed or topped up ------------------------
    public static void LeveledItems(PatchContext c)
    {
        foreach (var e in c.Spec["leveledItems"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var edid = e["list"]!.GetValue<string>();
            if (!c.TryWinning<ILeveledItemGetter>(edid, out var winning)) { c.Error($"leveled items: list '{edid}' not found"); continue; }
            // The server reads a list with a chance-none global as always empty
            if (!winning.Global.IsNull) { c.Error($"leveled items: {edid} takes its chance from a global, use chanceNone instead"); continue; }
            var rec = c.Override(c.Mod.LeveledItems, winning);
            rec.Entries ??= new ExtendedList<LeveledItemEntry>();
            var changes = new List<string>();
            if (e["chanceNone"] is JsonNode chance)
            {
                rec.ChanceNone = new Percent(chance.GetValue<int>() / 100.0);
                changes.Add($"chance none {chance.GetValue<int>()}%");
            }
            foreach (var item in Edids(c, e["remove"]))
            {
                var key = c.KeyOf<IItemGetter>(item);
                // Already gone on a re-run over a patched plugin
                if (rec.Entries.RemoveAll(x => x.Data?.Reference.FormKey == key) == 0) c.Note($"Leveled list {edid}: already without {item}");
                else changes.Add($"-{item}");
            }
            foreach (var a in e["add"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
            {
                var item = a["item"]!.GetValue<string>();
                var key = c.KeyOf<IItemGetter>(item);
                var count = a["count"]?.GetValue<short>() ?? 1;
                var level = a["level"]?.GetValue<short>() ?? 1;
                if (rec.Entries.Any(x => x.Data?.Reference.FormKey == key && x.Data.Count == count && x.Data.Level == level)) continue;
                var data = new LeveledItemEntryData { Level = level, Count = count };
                data.Reference.SetTo(key);
                rec.Entries.Add(new LeveledItemEntry { Data = data });
                changes.Add($"+{count}x {item}");
            }
            c.Note($"Leveled list {edid} ({winning.FormKey}): {(changes.Count > 0 ? string.Join(", ", changes) : "unchanged")}");
        }
    }

    // ---- orphan recipes: a recipe with no workbench keyword is an invalid record ------------------------------------
    //
    // The Creation Kit left one in the base plugin. No bench ever offered it, so it is parked where the hidden
    // recipes go rather than given a bench it never had.
    public static void Orphans(PatchContext c)
    {
        if (c.Spec["uncraftable"] is not JsonObject u) return;
        var bench = c.KeyOf<IKeywordGetter>(u["bench"]!.GetValue<string>());
        foreach (var cobj in c.Mod.ConstructibleObjects.Where(x => x.WorkbenchKeyword.FormKey == FormKey.Null).ToList())
        {
            cobj.WorkbenchKeyword.SetTo(bench);
            c.Note($"Orphan recipe: {cobj.EditorID} had no workbench keyword, parked");
            c.Report.Recipes.Add(new RecipeLine("uncraftable", cobj.EditorID!, c.NameOf(cobj.CreatedObject.FormKey), u["profession"]!.GetValue<string>(),
                                                "disabled", Items(c, cobj), note: "no workbench keyword of its own, parked"));
        }
    }

    // ---- bench moves: existing recipes offered at another bench only ------------------------------------------------
    public static void BenchMoves(PatchContext c)
    {
        var parked = (c.Spec["uncraftable"]?["recipes"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var m in c.Spec["benchMoves"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var bench = m["bench"]!.GetValue<string>();
            var recipes = m["recipes"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
            // A move may also claim recipes by what they make, at the benches it names in from
            var match = Edids(c, m["match"]).ToList();
            if (match.Count > 0)
            {
                var from = Edids(c, m["from"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
                foreach (var r in FinalRecipes(c).Select(kv => kv.Value).Where(r => from.Contains(r.Bench)))
                {
                    var made = c.Cache.TryResolve<IMajorRecordGetter>(r.Product, out var x) ? x : null;
                    var text = $"{r.Edid}|{made?.EditorID}|{c.NameOf(r.Product)}";
                    if (match.Any(t => text.Contains(t, StringComparison.OrdinalIgnoreCase)) && !parked.Contains(r.Edid) && !recipes.Contains(r.Edid))
                        recipes.Add(r.Edid);
                }
            }
            foreach (var edid in recipes.Where(parked.Contains)) c.Error($"bench move: '{edid}' is also in uncraftable");
            var key = c.KeyOf<IKeywordGetter>(bench);
            Park(c, recipes.Where(e => !parked.Contains(e)), key, "bench move", m["profession"]!.GetValue<string>(), "moved", $"moved to {bench}");
            var winners = c.LoadOrder.PriorityOrder.Furniture().WinningOverrides().ToDictionary(f => f.FormKey);
            foreach (var f in c.Mod.Furniture) winners[f.FormKey] = f;
            var offeredBy = winners.Values.Where(f => f.Keywords?.Any(k => k.FormKey == key) == true).Select(f => f.EditorID ?? f.FormKey.ToString());
            c.Note($"Bench move: {recipes.Count} recipes to {bench}, a keyword carried by {string.Join(", ", offeredBy)}");
        }
    }

    // ---- bench keyword removals: an existing bench stops offering a keyword's recipes ------------------------------
    public static void BenchKeywordRemovals(PatchContext c)
    {
        foreach (var (edid, list) in (c.Spec["benchKeywordRemovals"]?.AsObject() ?? new JsonObject()).Select(kv => (kv.Key, kv.Value!.AsArray())))
        {
            if (!c.TryWinning<IFurnitureGetter>(edid, out var winning)) { c.Warn($"bench keyword removal: bench '{edid}' not found, skipped"); continue; }
            var names = list.Select(x => x!.GetValue<string>()).ToList();
            var drop = names.Select(c.KeyOf<IKeywordGetter>).ToHashSet();
            if (winning.Keywords?.Any(k => drop.Contains(k.FormKey)) != true) { c.Note($"Bench {edid} ({winning.FormKey}): already without {string.Join(", ", names)}"); continue; }
            var furn = c.Override(c.Mod.Furniture, winning);
            furn.Keywords!.RemoveAll(k => drop.Contains(k.FormKey));
            c.Note($"Bench {edid} ({winning.FormKey}): {string.Join(", ", names)} removed");
        }
    }

    // ---- enchantment magnitudes: one effect of an enchantment only the listed armours carry --------------------------
    public static void EnchantmentMagnitudes(PatchContext c)
    {
        if (c.Spec["enchantmentMagnitudes"] is not JsonArray entries) return;
        var carriers = c.LoadOrder.PriorityOrder.Armor().WinningOverrides().Select(a => (a.FormKey, Ench: a.ObjectEffect.FormKeyNullable))
            .Concat(c.LoadOrder.PriorityOrder.Weapon().WinningOverrides().Select(w => (w.FormKey, Ench: w.ObjectEffect.FormKeyNullable)))
            .Where(x => x.Ench != null).ToLookup(x => x.Ench!.Value, x => x.FormKey);
        foreach (var e in entries.Select(x => x!.AsObject()))
        {
            var edid = e["enchantment"]!.GetValue<string>();
            var effect = c.KeyOf<IMagicEffectGetter>(e["effect"]!.GetValue<string>());
            var magnitude = e["magnitude"]!.GetValue<float>();
            var armors = e["armors"]!.AsArray().Select(x => c.Winning<IArmorGetter>(x!.GetValue<string>())).ToList();
            var enchs = armors.Select(a => a.ObjectEffect.FormKeyNullable).Distinct().ToList();
            if (enchs.Count != 1 || enchs[0] is not FormKey ench || !c.Cache.TryResolve<IObjectEffectGetter>(ench, out var winning) || winning.EditorID != edid)
            {
                c.Error($"enchantment {edid}: the listed armours carry {string.Join(", ", enchs.Select(x => x?.ToString() ?? "no enchantment"))}");
                continue;
            }
            var shared = carriers[ench].Except(armors.Select(a => a.FormKey)).ToList();
            if (shared.Count > 0) { c.Error($"enchantment {edid} is also carried by {string.Join(", ", shared.Select(c.EdidOf))}"); continue; }
            var rec = c.Override(c.Mod.ObjectEffects, winning);
            SetMagnitude(c, rec.Effects, effect, magnitude, $"Enchantment {edid} ({ench}) on {string.Join(", ", armors.Select(a => a.EditorID))}");
        }
    }

    // The magnitude of the one effect of a kind in a list; an error when there is not exactly one
    static void SetMagnitude(PatchContext c, IList<Effect> effects, FormKey effect, float magnitude, string label)
    {
        var hits = effects.Where(x => x.BaseEffect.FormKey == effect && x.Data != null).ToList();
        if (hits.Count != 1) { c.Error($"{label}: {hits.Count} effects of {c.EdidOf(effect)}, expected 1"); return; }
        c.Note($"{label}: {c.EdidOf(effect)} magnitude {hits[0].Data!.Magnitude} -> {magnitude}");
        hits[0].Data!.Magnitude = magnitude;
    }

    // ---- placements: a placed reference keeps the offset to its anchor that the defining plugin gave it -------------
    public static void Placements(PatchContext c)
    {
        var cache = (ILinkCache<ISkyrimMod, ISkyrimModGetter>)c.Cache;
        foreach (var p in c.Spec["placements"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var refKey = FormKey.Factory(p["ref"]!.GetValue<string>());
            var anchorKey = FormKey.Factory(p["anchor"]!.GetValue<string>());
            // Contexts run from the winning override down to the defining plugin
            var refs = cache.ResolveAllContexts<IPlacedObject, IPlacedObjectGetter>(refKey).ToList();
            var anchors = cache.ResolveAllContexts<IPlacedObject, IPlacedObjectGetter>(anchorKey).ToList();
            if (refs.Count == 0 || anchors.Count == 0) { c.Error($"placement: {refKey} or its anchor {anchorKey} not found"); continue; }
            var (refWin, refOrigin) = (refs[0].Record.Placement!, refs[^1].Record.Placement!);
            var (anchorWin, anchorOrigin) = (anchors[0].Record.Placement!, anchors[^1].Record.Placement!);
            // A pure translation only holds while neither record was rotated after its defining plugin
            if (refWin.Rotation != refOrigin.Rotation || anchorWin.Rotation != anchorOrigin.Rotation)
            {
                c.Error($"placement {refKey}: the reference or the anchor was rotated by {refs[0].ModKey} / {anchors[0].ModKey}");
                continue;
            }
            var target = new P3Float((float)((double)anchorWin.Position.X + refOrigin.Position.X - anchorOrigin.Position.X),
                                     (float)((double)anchorWin.Position.Y + refOrigin.Position.Y - anchorOrigin.Position.Y),
                                     (float)((double)anchorWin.Position.Z + refOrigin.Position.Z - anchorOrigin.Position.Z));
            if (refWin.Position == target) { c.Note($"Placement {refKey}: already at {target} in {refs[0].ModKey}"); continue; }
            var rec = refs[0].GetOrAddAsOverride(c.Mod);
            c.Note($"Placement {refKey} ({c.EdidOf(rec.Base.FormKey)}): {rec.Placement!.Position} from {refs[0].ModKey} -> {target}, anchor {anchorKey} at {anchorWin.Position} from {anchors[0].ModKey}");
            rec.Placement.Position = target;
        }
    }

    // ---- world changes: the references of AlduinakWorldChanges.esp, carried as spec data --------------------------
    //
    // Graves built that plugin in a Creation Kit that dropped its .esp master and rewrote every cell it opened, so
    // only its references are carried, as plain spec data.
    public static void World(PatchContext c)
    {
        if (c.Spec["world"] is not JsonObject w) return;
        var cache = (ILinkCache<ISkyrimMod, ISkyrimModGetter>)c.Cache;
        foreach (var p in w["placements"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var edid = p["edid"]!.GetValue<string>();
            var cellKey = FormKey.Factory(p["cell"]!.GetValue<string>());
            if (!cache.TryResolveContext<ICell, ICellGetter>(cellKey, out var cellCtx)) { c.Error($"world: cell {cellKey} not found"); continue; }
            var name = p["base"]!.GetValue<string>();
            // An editor id names one of the plugin's own records, a form key one of the load order's
            var baseKey = name.Contains(':') ? FormKey.Factory(name) : c.KeyOf<IMajorRecordGetter>(name);
            if (name.Contains(':') && !cache.TryResolve<IMajorRecordGetter>(baseKey, out _)) { c.Error($"world: base object {name} not found"); continue; }
            var id = Convert.ToUInt32(p["formId"]!.GetValue<string>(), 16);
            var cell = cellCtx.GetOrAddAsOverride(c.Mod);
            var placed = c.OwnOrNew(edid, () =>
            {
                var key = new FormKey(c.Key, id);
                if (c.Mod.EnumerateMajorRecords().Any(r => r.FormKey == key)) throw new SpecException($"world: '{edid}' wants the pinned id {key}, which another record already holds");
                var r = new PlacedObject(key, SkyrimRelease.SkyrimSE) { EditorID = edid };
                cell.Temporary.Add(r);
                return r;
            });
            placed.Base.SetTo(baseKey);
            placed.Placement = new Placement { Position = Vec3(p["pos"]), Rotation = Vec3(p["rot"]) };
            if (p["scale"] != null) placed.Scale = p["scale"]!.GetValue<float>();
            c.Note($"World reference {edid} {placed.FormKey}: {c.EdidOf(baseKey)} in cell {cellKey} at {placed.Placement.Position}");
        }
        foreach (var mv in w["moves"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var key = FormKey.Factory(mv["ref"]!.GetValue<string>());
            var refs = cache.ResolveAllContexts<IPlacedObject, IPlacedObjectGetter>(key).ToList();
            if (refs.Count == 0 || refs[0].Record.Placement == null) { c.Error($"world: reference {key} is not a placed object"); continue; }
            var rec = refs[0].GetOrAddAsOverride(c.Mod);
            var from = rec.Placement!.Position;
            rec.Placement.Position = Vec3(mv["pos"]);
            c.Note($"World move {key} ({c.EdidOf(rec.Base.FormKey)}): {from} in {refs[0].ModKey} -> {rec.Placement.Position}");
        }
    }

    static P3Float Vec3(JsonNode? n)
    {
        var a = n!.AsArray().Select(v => v!.GetValue<float>()).ToArray();
        return new P3Float(a[0], a[1], a[2]);
    }

    // ---- meadery: invisible stirring benches at the boilers, each offering its own mead, plus the honey recipe --------
    public static void Meadery(PatchContext c)
    {
        if (c.Spec["meadery"] is not JsonObject m) return;
        var profession = m["profession"]!.GetValue<string>();
        var shared = c.OwnOrNew(c.Mod.Keywords, m["keyword"]!.GetValue<string>()).FormKey;
        var benches = m["benches"]!.AsArray().Select(x => x!.AsObject()).ToList();
        var own = benches.Select(b => c.OwnOrNew(c.Mod.Keywords, b["keyword"]!.GetValue<string>()).FormKey).ToList();
        for (int i = 0; i < benches.Count; i++)
        {
            var b = benches[i];
            var bench = NewBench(c, m["template"]!.GetValue<string>(), b["edid"]!.GetValue<string>(), b["name"]!.GetValue<string>(), m["removeKeywords"]?.AsArray(), new[] { shared, own[i] });
            NewRecipe(c, b["recipe"]!.AsObject(), own[i], profession, "AldRecipeMead_");
            foreach (var p in b["placements"]!.AsArray().Select(x => x!.AsObject()))
                PlaceBench(c, b["cell"]!.GetValue<string>(), bench.FormKey, p);
        }
        // Every other drink is brewed at any boiler, on the shared keyword
        foreach (var r in (m["drinks"] as JsonArray ?? new JsonArray()).Select(x => x!.AsObject()))
            NewRecipe(c, r, shared, profession, "AldRecipeMead_");
        foreach (var h in (m["honey"] as JsonArray ?? new JsonArray()).Select(x => x!.AsObject()))
            NewRecipe(c, h, c.KeyOf<IKeywordGetter>(h["bench"]!.GetValue<string>()), h["profession"]!.GetValue<string>(), h["edid"] != null ? "" : "AldRecipeCook_");
    }

    const int PersistentFlag = 0x400;

    // A persistent reference of an own bench next to a vanilla boiler, kept in an override of the boiler's cell
    static void PlaceBench(PatchContext c, string cellEdid, FormKey bench, JsonObject p)
    {
        var cache = (ILinkCache<ISkyrimMod, ISkyrimModGetter>)c.Cache;
        var boilerKey = FormKey.Factory(p["boiler"]!.GetValue<string>());
        var edid = $"AldMeadBench_{boilerKey.ID:X6}";
        // The load order, not the plugin, decides the cell: an own override holds only the benches
        if (!cache.TryResolve<ICellGetter>(cellEdid, out var cellRec) || !cache.TryResolveContext<ICell, ICellGetter>(cellRec.FormKey, out var cellCtx))
        {
            c.Error($"meadery: cell '{cellEdid}' not found");
            return;
        }
        if (!cache.TryResolveContext<IPlacedObject, IPlacedObjectGetter>(boilerKey, out var boilerCtx) || boilerCtx.Record.Placement == null
            || boilerCtx.Parent?.Record is not ICellGetter boilerCell || boilerCell.FormKey != cellRec.FormKey)
        {
            c.Error($"meadery: boiler {boilerKey} is not a placed object of {cellEdid}");
            return;
        }
        var boiler = boilerCtx.Record;
        var xyz = p["pos"]!.AsArray().Select(v => v!.GetValue<float>()).ToArray();
        var position = new P3Float(xyz[0], xyz[1], xyz[2]);
        var rotZ = p["rotZ"]!.GetValue<float>();
        var distance = (position - boiler.Placement.Position).Magnitude;
        // Guards against a position surveyed at the wrong boiler
        if (distance > 256) { c.Error($"meadery: {edid} at {position} is {distance:0} units from its boiler {boilerKey}"); return; }
        var cell = cellCtx.GetOrAddAsOverride(c.Mod);
        var placed = c.OwnOrNew(edid, () =>
        {
            var r = new PlacedObject(c.Mod.GetNextFormKey(), SkyrimRelease.SkyrimSE) { EditorID = edid };
            cell.Persistent.Add(r);
            return r;
        });
        placed.Base.SetTo(bench);
        placed.MajorRecordFlagsRaw |= PersistentFlag;
        placed.Placement = new Placement { Position = position, Rotation = new P3Float(0, 0, rotZ * MathF.PI / 180) };
        if (p["scale"] != null) placed.Scale = p["scale"]!.GetValue<float>();
        c.Note($"Mead bench {edid} {placed.FormKey} in {cellEdid} at {position}, heading {rotZ}, scale {placed.Scale?.ToString() ?? "1"}, {distance:0} units from boiler {boilerKey}");
    }

    // ---- writings: blank and written letters, journals and books copied from vanilla notes, plus sealing wax -------
    public static void Writing(PatchContext c)
    {
        if (c.Spec["writing"] is not JsonObject w) return;
        var written = c.OwnOrNew(c.Mod.Keywords, w["keywords"]!["written"]!.GetValue<string>()).FormKey;
        var blank = c.OwnOrNew(c.Mod.Keywords, w["keywords"]!["blank"]!.GetValue<string>()).FormKey;
        foreach (var spec in w["books"]!.AsArray().Select(x => x!.AsObject()))
        {
            var edid = spec["edid"]!.GetValue<string>();
            var template = c.Winning<IBookGetter>(spec["template"]!.GetValue<string>());
            var book = c.OwnOrNew(c.Mod.Books, edid);
            var key = book.FormKey;
            book.DeepCopyIn(template);
            if (book.FormKey != key) throw new Exception("form key changed by DeepCopyIn");
            book.EditorID = edid;
            // Plain readable notes: no quest scripts, no skill or spell flag
            book.VirtualMachineAdapter = null;
            book.Teaches = new BookTeachesNothing { RawContent = 0xFFFFFFFF };
            book.Name = spec["name"]!.GetValue<string>();
            book.BookText = spec["text"]!.GetValue<string>();
            book.Value = spec["value"]!.GetValue<uint>();
            book.Weight = spec["weight"]!.GetValue<float>();
            var tag = spec["blank"]?.GetValue<bool>() == true ? blank : written;
            book.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
            book.Keywords.RemoveAll(k => k.FormKey == written || k.FormKey == blank);
            book.Keywords.Add(tag.ToLink<IKeywordGetter>());
            c.Note($"Writing {edid} {key} from {template.EditorID}, keyword {c.EdidOf(tag)}");
        }
        foreach (var spec in w["misc"]!.AsArray().Select(x => x!.AsObject())) MakeMisc(c, spec, "Writing");
        foreach (var r in w["recipes"]!.AsArray().Select(x => x!.AsObject()))
            NewRecipe(c, r, c.KeyOf<IKeywordGetter>(r["bench"]!.GetValue<string>()), r["profession"]!.GetValue<string>(), "AldRecipeWriting_");
    }

    // ---- the plugin's own carryable items (the hoe) ---------------------------------------------------------------
    public static void Items(PatchContext c)
    {
        foreach (var spec in (c.Spec["items"]?["misc"] as JsonArray ?? new JsonArray()).Select(x => x!.AsObject()))
            MakeMisc(c, spec, "Item");
    }

    // A new MISC copied from a template, optionally with another mesh and a pinned form id
    static void MakeMisc(PatchContext c, JsonObject spec, string kind)
    {
        var edid = spec["edid"]!.GetValue<string>();
        var template = c.Winning<IMiscItemGetter>(spec["template"]!.GetValue<string>());
        var misc = c.OwnOrNew(c.Mod.MiscItems, edid, formId: spec["formId"] is JsonNode id ? Convert.ToUInt32(id.GetValue<string>(), 16) : null);
        var key = misc.FormKey;
        misc.DeepCopyIn(template);
        if (misc.FormKey != key) throw new Exception("form key changed by DeepCopyIn");
        misc.EditorID = edid;
        misc.VirtualMachineAdapter = null;
        misc.Name = spec["name"]!.GetValue<string>();
        misc.Value = spec["value"]!.GetValue<uint>();
        misc.Weight = spec["weight"]!.GetValue<float>();
        if (spec["model"] is JsonNode model && misc.Model != null) misc.Model.File = model.GetValue<string>();
        c.Note($"{kind} {edid} {key} from {template.EditorID}");
    }

    // Material editor id -> rank index, from the owner's ingot table
    public static Dictionary<FormKey, int> MaterialTiers(PatchContext c)
    {
        var ranks = c.Ranks;
        var tiers = new Dictionary<FormKey, int>();
        foreach (var (rank, list) in c.Spec["smithing"]!["materials"]!.AsObject().Select(kv => (kv.Key, kv.Value!.AsArray())))
        {
            var idx = Array.IndexOf(ranks, rank);
            if (idx < 0) throw new SpecException($"smithing material rank '{rank}' unknown");
            foreach (var edid in list.Select(x => x!.GetValue<string>()))
            {
                if (!c.TryWinning<IMajorRecordGetter>(edid, out var mat)) { c.Error($"smithing material '{edid}' not found"); continue; }
                tiers[mat.FormKey] = Math.Max(tiers.GetValueOrDefault(mat.FormKey), idx);
            }
        }
        return tiers;
    }

    // The highest material among the inputs and the product decides the tier
    static int MaterialTierOf(IConstructibleObjectGetter cobj, Dictionary<FormKey, int> tiers)
    {
        var idx = tiers.GetValueOrDefault(cobj.CreatedObject.FormKey);
        foreach (var item in cobj.Items ?? new List<IContainerEntryGetter>())
            idx = Math.Max(idx, tiers.GetValueOrDefault(item.Item.Item.FormKey));
        return idx;
    }

    // Every recipe the tailoring step owns: the benches it sweeps plus the owner's list
    static HashSet<string> TailoringSet(PatchContext c)
    {
        var t = c.Spec["tailoring"]!.AsObject();
        var benches = Edids(c, t["benches"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
        var set = c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides()
            .Where(w => benches.Contains(w.WorkbenchKeyword.FormKey) && c.Includes(w))
            .Select(w => w.EditorID ?? "").Where(e => e.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var r in t["recipes"]!.AsArray()) set.Add(r!["edid"]!.GetValue<string>());
        return set;
    }

    // ---- tailoring: every recipe at the rack and the loom, the owner's list correcting ingredients and tiers --------
    public static void Tailoring(PatchContext c)
    {
        var t = c.Spec["tailoring"]!.AsObject();
        var profession = t["profession"]!.GetValue<string>();
        var strip = StripSet(c, true);
        var listed = t["recipes"]!.AsArray().Select(x => x!.AsObject()).ToDictionary(r => r["edid"]!.GetValue<string>(), r => r, StringComparer.OrdinalIgnoreCase);
        var tierOf = TierMap(t["tiers"]?.AsObject() ?? new JsonObject());
        var benches = Edids(c, t["benches"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
        // The sweep reads the load order, so a recipe an earlier step routed to the rack keeps the tier that step gave it
        var swept = c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides()
            .Where(w => benches.Contains(w.WorkbenchKeyword.FormKey) && c.Includes(w))
            .Select(w => w.EditorID ?? "").Where(e => e.Length > 0);
        // A hotfix run does not sweep the recipes the plugin already overrides, so the tier lists name theirs outright
        foreach (var edid in swept.Concat(listed.Keys).Concat(c.Hotfix ? tierOf.Keys : Enumerable.Empty<string>()).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var r = listed.GetValueOrDefault(edid);
            if (!c.TryWinning<IConstructibleObjectGetter>(edid, out var winning)) { c.Error($"tailoring recipe '{edid}' not found"); continue; }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            if (r?["bench"] != null) cobj.WorkbenchKeyword.SetTo(c.KeyOf<IKeywordGetter>(r["bench"]!.GetValue<string>()));
            if (r?["items"] != null)
            {
                cobj.Items = new ExtendedList<ContainerEntry>();
                foreach (var item in r["items"]!.AsObject())
                {
                    if (!c.TryWinning<IMajorRecordGetter>(item.Key, out var ing)) { c.Error($"tailoring recipe {edid}: ingredient '{item.Key}' not found"); continue; }
                    cobj.Items.Add(new ContainerEntry { Item = new ContainerItem { Item = ing.FormKey.ToLink<IItemGetter>(), Count = item.Value!.GetValue<int>() } });
                }
            }
            var stripped = cobj.Conditions.Any(cond => strip.Contains(FunctionOf(cond)));
            cobj.Conditions.RemoveAll(cond => strip.Contains(FunctionOf(cond)));
            var tier = r?["tier"]?.GetValue<string>() ?? tierOf.GetValueOrDefault(edid, c.Ranks[0]);
            var owner = r?["profession"]?.GetValue<string>() ?? profession;
            SetTier(c, cobj, owner, tier);
            c.Report.Recipes.Add(new RecipeLine("tailoring", edid, c.NameOf(cobj.CreatedObject.FormKey), owner, tier, Items(c, cobj), gatesStripped: stripped, origin: winning.FormKey.ModKey.FileName));
        }
        foreach (var r in t["newRecipes"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var bench = c.KeyOf<IKeywordGetter>(r["bench"]!.GetValue<string>());
            NewRecipe(c, r, bench, profession, "AldRecipeTailor_");
        }
        if (t["disableRecipes"] is JsonArray disable)
            Park(c, disable.Select(x => x!.GetValue<string>()), c.KeyOf<IKeywordGetter>(t["disabledBench"]!.GetValue<string>()), "tailoring", profession);
    }

    // ---- references the owner wants gone ---------------------------------------------------------------------------
    //
    // A deletion made in the Creation Kit does not survive: every plugin the server ships is regenerated from the
    // merged base, so the edit is simply not there next time. The references are listed here instead and come back
    // Initially Disabled on every run. Disabling rather than deleting is deliberate: a deleted reference other
    // plugins or old saves still point at is worse than one that never enables.
    public static void DisableReferences(PatchContext c)
    {
        if (c.Spec["disableReferences"] is not JsonObject spec) return;
        var cache = (ILinkCache<ISkyrimMod, ISkyrimModGetter>)c.Cache;
        int already = 0, disabled = 0;
        foreach (var name in Edids(c, spec["refs"]))
        {
            var key = FormKey.Factory(name);
            var contexts = cache.ResolveAllContexts<IPlacedObject, IPlacedObjectGetter>(key).ToList();
            if (contexts.Count == 0) { c.Error($"disable reference: {name} not found"); continue; }
            if ((contexts[0].Record.MajorRecordFlagsRaw & InitiallyDisabled) != 0) { already++; continue; }
            var rec = contexts[0].GetOrAddAsOverride(c.Mod);
            rec.MajorRecordFlagsRaw |= InitiallyDisabled;
            disabled++;
            c.Note($"Disabled reference {name} ({c.EdidOf(rec.Base.FormKey)}) from {contexts[0].ModKey}");
        }
        c.Note($"Disable references: {disabled} newly disabled, {already} already disabled");
    }

    const int InitiallyDisabled = 0x800;
    const int Deleted = 0x20;

    // ---- overrides: one field of a record another plugin defines, a quest's scripts, or an own placed reference -----
    public static void Overrides(PatchContext c)
    {
        if (c.Spec["overrides"] is not JsonObject o) return;
        var cache = (ILinkCache<ISkyrimMod, ISkyrimModGetter>)c.Cache;
        foreach (var m in Entries(o["misc"]))
        {
            var key = FormKey.Factory(m["item"]!.GetValue<string>());
            if (!cache.TryResolveContext<IMiscItem, IMiscItemGetter>(key, out var ctx)) { c.Error($"overrides: misc item {key} not found"); continue; }
            var weight = m["weight"]!.GetValue<float>();
            var from = ctx.Record.Weight;
            ctx.GetOrAddAsOverride(c.Mod).Weight = weight;
            c.Note($"Override {c.EdidOf(key)} ({key}, from {ctx.ModKey}): weight {from} -> {weight}");
        }
        foreach (var r in Entries(o["recipes"]))
        {
            var key = FormKey.Factory(r["recipe"]!.GetValue<string>());
            if (!cache.TryResolveContext<IConstructibleObject, IConstructibleObjectGetter>(key, out var ctx)) { c.Error($"overrides: recipe {key} not found"); continue; }
            var count = r["count"]!.GetValue<int>();
            var from = ctx.Record.CreatedObjectCount;
            ctx.GetOrAddAsOverride(c.Mod).CreatedObjectCount = (ushort)count;
            c.Note($"Override {c.EdidOf(key)} ({key}, from {ctx.ModKey}): created object count {from} -> {count}");
        }
        foreach (var f in Entries(o["foods"]))
        {
            var key = FormKey.Factory(f["item"]!.GetValue<string>());
            if (!cache.TryResolveContext<IIngestible, IIngestibleGetter>(key, out var ctx)) { c.Error($"overrides: food {key} not found"); continue; }
            var from = c.KeyOf<IMagicEffectGetter>(f["from"]!.GetValue<string>());
            var to = c.KeyOf<IMagicEffectGetter>(f["hunger"]!.GetValue<string>());
            // Matching the new effect too keeps a re-run on a patched plugin idempotent
            var at = ctx.Record.Effects.Select((e, i) => e.BaseEffect.FormKey == from || e.BaseEffect.FormKey == to ? i : -1).Where(i => i >= 0).ToList();
            if (at.Count != 1) { c.Error($"overrides: food {c.EdidOf(key)} ({key}) carries {at.Count} {c.EdidOf(from)} effects, expected 1"); continue; }
            ctx.GetOrAddAsOverride(c.Mod).Effects[at[0]].BaseEffect.SetTo(to);
            c.Note($"Override {c.EdidOf(key)} ({key}, from {ctx.ModKey}): {c.EdidOf(from)} -> {c.EdidOf(to)}");
        }
        foreach (var p in Entries(o["refs"]))
        {
            var edid = p["ref"]!.GetValue<string>();
            if (!c.TryWinning<IPlacedObjectGetter>(edid, out var winning) || winning is not PlacedObject placed || placed.FormKey.ModKey != c.Key)
            {
                c.Error($"overrides: '{edid}' is not a placed reference of the plugin's own");
                continue;
            }
            var scale = p["scale"]!.GetValue<float>();
            c.Note($"Override {edid} ({placed.FormKey}): scale {placed.Scale?.ToString() ?? "1"} -> {scale}");
            placed.Scale = scale;
        }
        foreach (var q in Entries(o["quests"]))
        {
            var key = FormKey.Factory(q["quest"]!.GetValue<string>());
            if (!cache.TryResolveContext<IQuest, IQuestGetter>(key, out var ctx)) { c.Error($"overrides: quest {key} not found"); continue; }
            var drop = q["dropScripts"]!.AsArray().Select(x => x!.GetValue<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var removed = ctx.GetOrAddAsOverride(c.Mod).VirtualMachineAdapter?.Scripts.RemoveAll(s => drop.Contains(s.Name)) ?? 0;
            c.Note($"Override {c.EdidOf(key)} ({key}, from {ctx.ModKey}): {removed} script(s) dropped ({string.Join(", ", drop)})");
        }
    }

    static IEnumerable<JsonObject> Entries(JsonNode? list) =>
        (list as JsonArray)?.Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>();

    // ---- actors: no placed NPC, living or dead, ever shows ----------------------------------------------------------
    //
    // The server spawns none of them, but the game still loads them. An enable parent decides over the flag, so an actor
    // with one gets the player as parent, opposite: always off, the xEdit idiom for a removed reference.
    public static void DisableActors(PatchContext c)
    {
        if (c.Spec["disableActors"] is not JsonObject spec) return;
        var cache = (ILinkCache<ISkyrimMod, ISkyrimModGetter>)c.Cache;
        var player = FormKey.Factory("000014:Skyrim.esm");
        var keep = Edids(c, spec["except"]).Select(x => FormKey.Factory(x)).Append(player).ToHashSet();
        int already = 0, parents = 0;
        var disabled = new Dictionary<ModKey, int>();
        var worlds = c.Mod.Worldspaces.Select(w => w.FormKey).ToHashSet();
        foreach (var ctx in c.LoadOrder.PriorityOrder.PlacedNpc().WinningContextOverrides(c.Cache).ToList())
        {
            var r = ctx.Record;
            if (keep.Contains(r.FormKey) || (r.MajorRecordFlagsRaw & Deleted) != 0) continue;
            var off = r.EnableParent == null || r.EnableParent.Reference.FormKey == player && r.EnableParent.Flags.HasFlag(EnableParent.Flag.SetEnableStateToOppositeOfParent);
            if ((r.MajorRecordFlagsRaw & InitiallyDisabled) != 0 && off) { already++; continue; }
            // The cell comes from its own winner, not from the plugin the actor wins in
            if (ctx.Parent?.Record is ICellGetter cell) cache.ResolveContext<ICell, ICellGetter>(cell.FormKey).GetOrAddAsOverride(c.Mod);
            var rec = ctx.GetOrAddAsOverride(c.Mod);
            rec.MajorRecordFlagsRaw |= InitiallyDisabled;
            if (!off)
            {
                rec.EnableParent = new EnableParent { Reference = player.ToLink<IPlacedGetter>(), Flags = EnableParent.Flag.SetEnableStateToOppositeOfParent };
                parents++;
            }
            disabled[ctx.ModKey] = disabled.GetValueOrDefault(ctx.ModKey) + 1;
        }
        // A worldspace added for its cells takes the fields of its last winner the plugin may master; the offset table only fits the file it came from
        var notFrom = Edids(c, spec["notFrom"]).Select(n => ModKey.FromNameAndExtension(n)).ToHashSet();
        var mask = new Worldspace.TranslationMask(defaultOn: true) { TopCell = false, SubCells = false, SubCellsTimestamp = false, SubCellsUnknown = false, OffsetData = false };
        foreach (var w in c.Mod.Worldspaces.Where(w => !worlds.Contains(w.FormKey)))
            w.DeepCopyIn(cache.ResolveAllContexts<IWorldspace, IWorldspaceGetter>(w.FormKey).First(x => !notFrom.Contains(x.ModKey)).Record, mask);
        c.Note($"Disable actors: {disabled.Values.Sum()} newly disabled, {parents} of them given the player as enable parent, opposite; {already} already disabled");
        c.Note($"Disable actors by winning plugin: {string.Join(", ", disabled.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key.FileName} {kv.Value}"))}");
    }

    // ---- races: the powers and passives the game hands every character of a race -----------------------------------
    //
    // The server reads the starting attributes and the unarmed damage from the race as well, so both sides agree.
    public static void Races(PatchContext c)
    {
        if (c.Spec["races"] is not JsonObject spec) return;
        var types = Edids(c, spec["removeSpellTypes"]).Select(x => Enum.Parse<SpellType>(x)).ToHashSet();
        var keep = Edids(c, spec["keepSpells"]).Select(c.KeyOf<ISpellGetter>).ToHashSet();
        var passives = (spec["passives"]?.AsArray() ?? []).Select(x => x!.AsObject())
            .SelectMany(p => Edids(c, p["races"]).Select(r => (Race: r, Spec: p))).ToDictionary(x => x.Race, x => x.Spec);
        foreach (var edid in Edids(c, spec["races"]))
        {
            var winning = c.Winning<IRaceGetter>(edid);
            var p = passives.GetValueOrDefault(edid);
            var named = Edids(c, p?["removeSpells"]).Select(c.KeyOf<ISpellGetter>).ToHashSet();
            var drop = (winning.ActorEffect ?? []).Select(s => s.FormKey)
                .Where(k => named.Contains(k) || !keep.Contains(k) && c.Cache.TryResolve<ISpellGetter>(k, out var spell) && types.Contains(spell.Type)).ToHashSet();
            var starting = new[] { BasicStat.Health, BasicStat.Magicka, BasicStat.Stamina }
                .Where(s => p?[$"starting{s}"] != null).ToDictionary(s => s, s => p![$"starting{s}"]!.GetValue<float>());
            var unarmed = p?["unarmedDamageFrom"] is JsonNode weapon ? c.Winning<IWeaponGetter>(weapon.GetValue<string>()).BasicStats!.Damage : p?["unarmedDamage"]?.GetValue<float>();
            var description = spec["descriptions"]?[edid]?.GetValue<string>();
            var changes = drop.Select(k => $"{c.EdidOf(k)} removed")
                .Concat(starting.Where(s => winning.Starting[s.Key] != s.Value).Select(s => $"starting {s.Key} {winning.Starting[s.Key]} -> {s.Value}"))
                .Concat(unarmed is float u && winning.UnarmedDamage != u ? [$"unarmed damage {winning.UnarmedDamage} -> {u}{(p!["unarmedDamageFrom"] is JsonNode w ? $" ({w})" : "")}"] : [])
                .Concat(description != null && winning.Description?.String != description ? ["description"] : []).ToList();
            if (changes.Count == 0) continue;
            var race = c.Override(c.Mod.Races, winning);
            race.ActorEffect?.RemoveAll(s => drop.Contains(s.FormKey));
            foreach (var (stat, value) in starting) race.Starting[stat] = value;
            if (unarmed is float damage) race.UnarmedDamage = damage;
            if (description != null) race.Description = description;
            c.Note($"Race {edid}: {string.Join(", ", changes)}");
        }
        // Passive abilities shared by a race and its vampire form
        foreach (var s in (spec["spells"]?.AsArray() ?? []).Select(x => x!.AsObject()))
        {
            var spell = c.Override(c.Mod.Spells, c.Winning<ISpellGetter>(s["spell"]!.GetValue<string>()));
            foreach (var (effect, magnitude) in s["effects"]!.AsObject())
                SetMagnitude(c, spell.Effects, c.KeyOf<IMagicEffectGetter>(effect), magnitude!.GetValue<float>(), $"Race ability {spell.EditorID}");
        }
    }

    // ---- head parts: the races character creation offers a head part to --------------------------------------------
    public static void HeadParts(PatchContext c)
    {
        foreach (var entry in (c.Spec["headParts"]?.AsArray() ?? []).Select(x => x!.AsObject()))
        {
            var races = c.KeyOf<IFormListGetter>(entry["validRaces"]!.GetValue<string>());
            foreach (var edid in Edids(c, entry["parts"]))
            {
                var winning = c.Winning<IHeadPartGetter>(edid);
                if (winning.ValidRaces.FormKey == races) continue;
                c.Override(c.Mod.HeadParts, winning).ValidRaces.SetTo(races);
                c.Note($"Head part {edid}: offered to {c.EdidOf(races)} instead of {c.EdidOf(winning.ValidRaces.FormKey)}");
            }
        }
    }

    // ---- faction gear: only a member of that faction may make it --------------------------------------------------
    //
    // The game's own factions mean nothing here: membership lives in the backend, so each craft faction gets an
    // Ability marker of its own that the server grants and revokes (skymp5-server/ts/systems/factionCraftSystem.ts),
    // and its recipes carry the same HasSpell condition the rank markers use.
    public static void Factions(PatchContext c)
    {
        if (c.Spec["factions"] is not JsonObject spec) return;
        var benches = Edids(c, spec["benches"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
        var rules = spec["list"]!.AsArray().Select(x => x!.AsObject())
            .Select(x => (Id: x["id"]!.GetValue<string>(),
                          Name: x["name"]!.GetValue<string>(),
                          Match: Edids(c, x["match"]).ToList(),
                          All: Edids(c, x["all"]).ToList(),
                          Except: Edids(c, x["except"]).ToList(),
                          // Further factions whose members may also make it, one OR group with the rule's own
                          Also: Edids(c, x["also"]).ToList(),
                          Creations: x["creations"]?.GetValue<bool>() == true)).ToList();
        var marker = new Dictionary<string, FormKey>();
        // A faction's marker takes its name from its own entry, not from a shared rule naming it
        foreach (var g in rules.GroupBy(r => r.Id))
        {
            var spell = c.OwnOrNew(c.Mod.Spells, MarkerEdidOf(g.Key));
            spell.Name = $"Faction: {g.FirstOrDefault(r => r.Also.Count == 0).Name ?? g.First().Name}";
            spell.Type = SpellType.Ability;
            spell.CastType = CastType.ConstantEffect;
            spell.TargetType = TargetType.Self;
            spell.Flags |= SpellDataFlag.ManualCostCalc;
            marker[g.Key] = spell.FormKey;
        }
        foreach (var id in rules.SelectMany(r => r.Also).Where(id => !marker.ContainsKey(id)).Distinct())
            c.Error($"factions: '{id}' is named in also but has no entry of its own");
        var markers = marker.Values.ToHashSet();
        var counts = rules.Select(r => r.Name).Distinct().ToDictionary(n => n, _ => 0);
        foreach (var (key, cobj) in FinalRecipes(c))
        {
            if (!benches.Contains(cobj.Bench)) continue;
            var made = c.Cache.TryResolve<IMajorRecordGetter>(cobj.Product, out var m) ? m : null;
            var text = $"{cobj.Edid}|{made?.EditorID}|{c.NameOf(cobj.Product)}";
            var creation = c.CreationKeys.Contains(key.ModKey);
            var hit = rules.FirstOrDefault(r => (!creation || r.Creations)
                                             && (r.Match.Count > 0 && r.Match.Any(x => text.Contains(x, StringComparison.OrdinalIgnoreCase))
                                                 || r.All.Count > 0 && r.All.All(x => text.Contains(x, StringComparison.OrdinalIgnoreCase)))
                                             && !r.Except.Any(x => text.Contains(x, StringComparison.OrdinalIgnoreCase)));
            if (hit.Id == null) continue;
            if (!c.TryWinning<IConstructibleObjectGetter>(cobj.Edid, out var winning)) { c.Error($"factions: recipe '{cobj.Edid}' not found"); continue; }
            var rec = c.Override(c.Mod.ConstructibleObjects, winning);
            // The game's own factions and a people's gate mean nothing on faction gear; membership replaces them
            rec.Conditions.RemoveAll(cond => cond.Data is IHasSpellConditionDataGetter hs && markers.Contains(hs.Spell.Link.FormKey)
                                             || ClaimStrip.Contains(FunctionOf(cond)));
            if (rec.Conditions.Count > 0) rec.Conditions[^1].Flags &= ~Condition.Flag.OR;
            var ids = hit.Also.Prepend(hit.Id).Where(marker.ContainsKey).Distinct().ToList();
            for (int i = 0; i < ids.Count; i++)
            {
                var data = new HasSpellConditionData { RunOnType = Condition.RunOnType.Subject };
                data.Spell.Link.SetTo(marker[ids[i]]);
                rec.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.EqualTo, ComparisonValue = 1f, Data = data, Flags = i < ids.Count - 1 ? Condition.Flag.OR : default });
            }
            counts[hit.Name] += 1;
            c.Claimed.Add(cobj.Edid);
            c.Report.Recipes.Add(new RecipeLine("faction", cobj.Edid, c.NameOf(cobj.Product), hit.Name, "-", Items(c, rec), note: $"only {hit.Name}"));
        }
        c.Note($"Faction gear: {string.Join(", ", counts.Select(kv => $"{kv.Value} {kv.Key}"))}");
    }

    static readonly HashSet<string> ClaimStrip = new(StringComparer.OrdinalIgnoreCase) { "GetInFaction", "GetPCInFaction", "GetIsRace" };

    // The server finds the markers by this editor id; the faction id's punctuation has no place in one
    public static string MarkerEdidOf(string factionId) =>
        "AldFaction_" + new string(factionId.Where(char.IsLetterOrDigit).ToArray());

    // ---- racial gear: only a smith of that people may make it -----------------------------------------------------
    //
    // GetIsRace is one of the few condition functions the server implements, so the crafting menu and CraftService
    // agree on it. The race conditions form one OR group after the rank condition: [rank] AND [race or race...].
    public static void Racial(PatchContext c)
    {
        if (c.Spec["racial"] is not JsonObject spec) return;
        var benches = Edids(c, spec["benches"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
        var rules = spec["races"]!.AsArray().Select(x => x!.AsObject())
            .Select(x => (Name: x["name"]!.GetValue<string>(),
                          Races: Edids(c, x["races"]).Select(c.KeyOf<IRaceGetter>).ToList(),
                          Match: Edids(c, x["match"]).ToList(),
                          // Ingredients that make a recipe that people's work whatever it is called
                          Items: Edids(c, x["items"]).Select(c.KeyOf<IMajorRecordGetter>).ToHashSet(),
                          Except: Edids(c, x["except"]).ToList())).ToList();
        var counts = rules.ToDictionary(r => r.Name, _ => 0);
        foreach (var (key, cobj) in FinalRecipes(c))
        {
            if (!benches.Contains(cobj.Bench) || c.CreationKeys.Contains(key.ModKey)) continue;
            var edid = cobj.Edid;
            // A recipe a faction already owns is that faction's, whatever people its gear is styled after;
            // gating it twice would ask for the race and the membership at once
            if (c.Claimed.Contains(edid)) continue;
            var made = c.Cache.TryResolve<IMajorRecordGetter>(cobj.Product, out var m) ? m : null;
            var text = $"{edid}|{made?.EditorID}|{c.NameOf(cobj.Product)}";
            var inputs = c.TryWinning<IConstructibleObjectGetter>(edid, out var recipe)
                ? (recipe.Items ?? new List<IContainerEntryGetter>()).Select(i => i.Item.Item.FormKey).ToList()
                : new List<FormKey>();
            var hit = rules.FirstOrDefault(r => (r.Match.Any(x => text.Contains(x, StringComparison.OrdinalIgnoreCase))
                                                 || r.Items.Count > 0 && inputs.Any(r.Items.Contains))
                                             && !r.Except.Any(x => text.Contains(x, StringComparison.OrdinalIgnoreCase)));
            if (hit.Name == null) continue;
            if (!c.TryWinning<IConstructibleObjectGetter>(edid, out var winning)) { c.Error($"racial: recipe '{edid}' not found"); continue; }
            var rec = c.Override(c.Mod.ConstructibleObjects, winning);
            rec.Conditions.RemoveAll(cond => cond.Data is IGetIsRaceConditionDataGetter);
            if (rec.Conditions.Count > 0) rec.Conditions[^1].Flags &= ~Condition.Flag.OR;
            for (int i = 0; i < hit.Races.Count; i++)
            {
                var data = new GetIsRaceConditionData();
                data.Race.Link.SetTo(hit.Races[i]);
                rec.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1f,
                    Data = data,
                    Flags = i < hit.Races.Count - 1 ? Condition.Flag.OR : default,
                });
            }
            counts[hit.Name] += 1;
            c.Report.Recipes.Add(new RecipeLine("racial", edid, c.NameOf(cobj.Product), hit.Name, "-", Items(c, rec), note: $"only {hit.Name}"));
        }
        c.Note($"Racial gear: {string.Join(", ", counts.Select(kv => $"{kv.Value} {kv.Key}"))}");
    }

    record FinalRecipe(string Edid, FormKey Bench, FormKey Product);

    // Every recipe as it stands after the earlier steps: the plugin's own overrides win over the load order's.
    static IEnumerable<KeyValuePair<FormKey, FinalRecipe>> FinalRecipes(PatchContext c)
    {
        var final = new Dictionary<FormKey, FinalRecipe>();
        foreach (var w in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
            if (c.Includes(w) && !string.IsNullOrEmpty(w.EditorID))
                final[w.FormKey] = new FinalRecipe(w.EditorID!, w.WorkbenchKeyword.FormKey, w.CreatedObject.FormKey);
        foreach (var own in c.Mod.ConstructibleObjects)
            if (!string.IsNullOrEmpty(own.EditorID))
                final[own.FormKey] = new FinalRecipe(own.EditorID!, own.WorkbenchKeyword.FormKey, own.CreatedObject.FormKey);
        return final;
    }

    // ---- crafting categories: the filter tabs the CraftingCategories SKSE plugin draws ----------------------------
    //
    // It reads keywords off the created object and puts an item in one section and one category of that section only,
    // so every item the benches make gets one slot section keyword and one race or material keyword of the plugin's
    // own, and the json names them. Runs last, when every bench keyword and race gate is final.
    public static JsonObject Categories(PatchContext c)
    {
        var config = new JsonObject();
        if (c.Spec["craftingCategories"] is not JsonObject spec) return config;
        var prefix = spec["keywordPrefix"]!.GetValue<string>();
        var benches = Edids(c, spec["benches"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
        var sections = spec["sections"]!.AsArray().Select(x => x!.AsObject())
            .Select(x => (Name: x["name"]!.GetValue<string>(), Priority: x["priority"]!.GetValue<int>(), Icon: x["icon"]!.GetValue<string>(),
                          Slots: Edids(c, x["slots"]).Select(int.Parse).ToList(),
                          Kinds: Edids(c, x["kinds"]).ToHashSet(StringComparer.OrdinalIgnoreCase),
                          Keywords: Edids(c, x["keywords"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet())).ToList();
        // A race category is the racial rule whose races gate the recipe
        var races = c.Spec["racial"]!["races"]!.AsArray().Select(x => x!.AsObject())
            .Select(x => (Name: x["name"]!.GetValue<string>(), Races: Edids(c, x["races"]).Select(c.KeyOf<IRaceGetter>).ToHashSet())).ToList();
        var materials = spec["materials"]!.AsArray().Select(x => x!.AsObject())
            .Select(x => (Name: x["name"]!.GetValue<string>(), Items: Edids(c, x["items"]).Select(c.KeyOf<IMajorRecordGetter>).ToHashSet(),
                          Keywords: Edids(c, x["itemKeywords"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet())).ToList();
        var ignore = Edids(c, spec["ignoreItems"]).Select(c.KeyOf<IMajorRecordGetter>).ToHashSet();
        var tagged = new List<(IMajorRecordGetter Made, int Section, string? Tab, string? Keyword)>();
        foreach (var group in FinalRecipes(c).Select(kv => kv.Value).Where(r => benches.Contains(r.Bench)).GroupBy(r => r.Product))
        {
            if (!c.Cache.TryResolve<IMajorRecordGetter>(group.Key, out var made)) continue;
            var kws = ProductKeywords(c, group.Key, out var kind);
            var slots = made is IArmorGetter { BodyTemplate: { } body } ? (uint)body.FirstPersonFlags : 0u;
            var section = sections.FindIndex(x => x.Slots.Any(sl => (slots & (1u << (sl - 30))) != 0) || x.Kinds.Contains(kind) || kws.Overlaps(x.Keywords));
            if (section < 0) continue;
            var recipes = group.Select(r => c.Winning<IConstructibleObjectGetter>(r.Edid)).ToList();
            var gate = recipes.SelectMany(r => r.Conditions).Select(cond => cond.Data).OfType<IGetIsRaceConditionDataGetter>().Select(d => d.Race.Link.FormKey).ToHashSet();
            var race = races.FirstOrDefault(r => r.Races.Overlaps(gate)).Name;
            if (race != null) { tagged.Add((made, section, race, $"{prefix}Race_{race}")); continue; }
            // The material the recipes use most of; a tie goes to the one listed first
            var used = new Dictionary<int, int>();
            foreach (var entry in recipes.SelectMany(r => r.Items ?? []).Where(i => !ignore.Contains(i.Item.Item.FormKey)))
            {
                var m = materials.FindIndex(x => x.Items.Contains(entry.Item.Item.FormKey) || ItemKeywords(c, entry.Item.Item.FormKey).Overlaps(x.Keywords));
                if (m >= 0) used[m] = used.GetValueOrDefault(m) + entry.Item.Count;
            }
            var material = used.Count == 0 ? null : materials[used.OrderByDescending(u => u.Value).ThenBy(u => u.Key).First().Key].Name;
            tagged.Add((made, section, material, material == null ? null : $"{prefix}Mat_{new string(material.Where(char.IsLetterOrDigit).ToArray())}"));
        }
        var sectionKeys = sections.Select(x => c.OwnOrNew(c.Mod.Keywords, $"{prefix}Slot_{x.Name}").FormKey).ToList();
        // A tab added later pins its id, so it cannot push the tabs created after it in first-use order
        var pinned = spec["formIds"] as JsonObject ?? new JsonObject();
        var tabKeys = tagged.Where(t => t.Keyword != null).Select(t => t.Keyword!).Distinct().ToDictionary(k => k,
            k => c.OwnOrNew(c.Mod.Keywords, k, formId: pinned[k] is JsonNode pin ? Convert.ToUInt32(pin.GetValue<string>(), 16) : null).FormKey);
        // Older category keywords of the plugin's own leave the items that get new ones
        var family = c.Mod.Keywords.Where(k => (k.EditorID ?? "").StartsWith(prefix, StringComparison.Ordinal)).Select(k => k.FormKey).ToHashSet();
        foreach (var t in tagged)
            Tag(c, t.Made, t.Keyword == null ? [sectionKeys[t.Section]] : [sectionKeys[t.Section], tabKeys[t.Keyword]], family);
        var icons = spec["iconSource"]!.GetValue<string>();
        config["sections"] = new JsonObject(sections.Select(x => KeyValuePair.Create(x.Name, (JsonNode?)new JsonObject
        {
            ["priority"] = x.Priority,
            ["keywords"] = new JsonArray($"{prefix}Slot_{x.Name}"),
            ["icon"] = new JsonObject { ["source"] = icons, ["label"] = x.Icon },
        })));
        // A label names one category per file, so the same race or material in a later section carries trailing spaces
        config["categories"] = new JsonObject(tagged.Where(t => t.Keyword != null).Select(t => (t.Section, Tab: t.Tab!, Keyword: t.Keyword!)).Distinct()
            .OrderBy(t => t.Section).ThenBy(t => t.Keyword.Contains("Race_") ? 0 : 1).ThenBy(t => t.Tab)
            .Select(t => KeyValuePair.Create(t.Tab + new string(' ', t.Section), (JsonNode?)new JsonObject
            {
                ["section"] = sections[t.Section].Name,
                ["keywords"] = new JsonArray(t.Keyword),
            })));
        foreach (var (x, i) in sections.Select((x, i) => (x, i)))
        {
            var items = tagged.Where(t => t.Section == i).ToList();
            c.Note($"Crafting categories, {x.Name}: {items.Count} items; {string.Join(", ", items.GroupBy(t => t.Tab ?? "Other").OrderByDescending(g => g.Count()).Select(g => $"{g.Count()} {g.Key}"))}");
        }
        return config;
    }

    // The category keywords on an override of a created object, whatever record type it is; its older ones of the family go
    static void Tag(PatchContext c, IMajorRecordGetter made, ICollection<FormKey> keywords, ISet<FormKey> family)
    {
        IKeyworded<IKeywordGetter>? rec = made switch
        {
            IArmorGetter a => c.Override(c.Mod.Armors, a),
            IWeaponGetter w => c.Override(c.Mod.Weapons, w),
            IAmmunitionGetter m => c.Override(c.Mod.Ammunitions, m),
            IMiscItemGetter m => c.Override(c.Mod.MiscItems, m),
            IBookGetter b => c.Override(c.Mod.Books, b),
            _ => null,
        };
        if (rec == null) { c.Warn($"crafting categories: {made.EditorID} is a {made.Registration.Name}, which carries no keywords"); return; }
        rec.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
        rec.Keywords.RemoveAll(k => family.Contains(k.FormKey) && !keywords.Contains(k.FormKey));
        foreach (var keyword in keywords)
            if (!rec.Keywords.Any(k => k.FormKey == keyword)) rec.Keywords.Add(keyword.ToLink<IKeywordGetter>());
    }

    // ---- helpers -------------------------------------------------------------------------------------------------
    static Dictionary<string, string> TierMap(JsonObject tiers)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (tier, list) in tiers.Select(kv => (kv.Key, kv.Value!.AsArray())))
            foreach (var edid in list.Select(x => x!.GetValue<string>()))
            {
                if (map.TryGetValue(edid, out var other) && other != tier) throw new SpecException($"recipe '{edid}' is listed under both {other} and {tier}");
                map[edid] = tier;
            }
        return map;
    }

    // The condition functions the server cannot evaluate; an unregistered one answers true server-side
    static HashSet<string> StripSet(PatchContext c, bool withPerks)
    {
        var set = (c.Spec["stripConditions"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!withPerks) set.Remove("HasPerk");
        return set;
    }

    static string FunctionOf(IConditionGetter cond)
    {
        var name = cond.Data.GetType().Name;
        return name.EndsWith("ConditionData") ? name[..^"ConditionData".Length] : name;
    }

    static bool HasAldCondition(PatchContext c, IConstructibleObjectGetter cobj) =>
        cobj.Conditions.Any(cond => cond.Data is IHasSpellConditionDataGetter hs && hs.Spell.Link.FormKey.ModKey == c.MarkerKey);

    // Replace every existing marker condition by the one for this tier; only Anyone leaves a recipe ungated.
    static void SetTier(PatchContext c, ConstructibleObject cobj, string profession, string tier)
    {
        if (tier != PatchContext.AnyoneTier && Array.IndexOf(c.Ranks, tier) < 0) throw new SpecException($"unknown tier '{tier}' on {cobj.EditorID}");
        cobj.Conditions.RemoveAll(cond => cond.Data is IHasSpellConditionDataGetter hs && hs.Spell.Link.FormKey.ModKey == c.MarkerKey);
        if (tier == PatchContext.AnyoneTier) return;
        // A trailing OR would let the marker join that group and the gate would pass without it
        if (cobj.Conditions.Count > 0) cobj.Conditions[^1].Flags &= ~Condition.Flag.OR;
        var marker = c.Winning<ISpellGetter>(c.MarkerEdid(profession, tier));
        var data = new HasSpellConditionData { RunOnType = Condition.RunOnType.Subject };
        data.Spell.Link.SetTo(marker.FormKey);
        cobj.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.EqualTo, ComparisonValue = 1f, Data = data });
    }

    static List<string> Items(PatchContext c, IConstructibleObjectGetter cobj) =>
        (cobj.Items ?? new List<IContainerEntryGetter>()).Select(i => $"{i.Item.Count}x {c.NameOf(i.Item.Item.FormKey)}").ToList();
}

static class ContextExtensions
{
    public static string EdidOf(this PatchContext c, FormKey key) => c.Cache.TryResolveIdentifier(key, out var edid) && edid != null ? edid : key.ToString();
    public static string NameOf(this PatchContext c, FormKey key)
    {
        if (c.Cache.TryResolve<INamedGetter>(key, out var named) && !string.IsNullOrEmpty(named.Name)) return named.Name!;
        return c.EdidOf(key);
    }
}

// Where a routed recipe ends up; Hidden parks it on the keyword no furniture carries.
record Route(FormKey Bench, string BenchEdid, string Profession, bool Hidden = false);

record RecipeLine(string Kind, string Edid, string Output, string Profession, string Tier, List<string> Items, bool untouched = false, bool salted = false, bool gatesStripped = false, string? origin = null, string? note = null);

class Report
{
    public readonly List<string> Errors = new();
    public readonly List<string> Warnings = new();
    public readonly List<string> Notes = new();
    public readonly List<string> NewRecords = new();
    public readonly List<RecipeLine> Recipes = new();
    readonly int loadIndex;
    readonly ModKey key;
    public Report(int loadIndex, ModKey key) { this.loadIndex = loadIndex; this.key = key; }

    public uint GlobalId(FormKey k) => (uint)(loadIndex << 24) | k.ID;

    public void Write(string dir, SkyrimMod mod, ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> loadOrder, bool failed, string reportName = "proficiency-report.md")
    {
        Directory.CreateDirectory(dir);
        var md = new List<string>();
        md.Add($"# {(reportName == "proficiency-report.md" ? "Proficiency" : key.FileName.String)} patch report{(failed ? " (FAILED)" : "")}");
        md.Add("");
        if (Errors.Count > 0) { md.Add("## Errors"); md.AddRange(Errors.Select(e => "- " + e)); md.Add(""); }
        if (Warnings.Count > 0) { md.Add("## Warnings"); md.AddRange(Warnings.Select(e => "- " + e)); md.Add(""); }
        md.Add("## Masters");
        md.AddRange(mod.ModHeader.MasterReferences.Select((m, i) => $"- {i:X2} {m.Master.FileName}"));
        md.Add("");
        md.Add("## Marker spells (global form ids for the server)");
        var spells = new JsonObject();
        foreach (var s in mod.Spells.Where(s => s.FormKey.ModKey == key && (s.EditorID ?? "").StartsWith("AldMastery_")))
        {
            md.Add($"- {s.EditorID}: {s.FormKey} global 0x{GlobalId(s.FormKey):X8} '{s.Name?.String}' effects={s.Effects.Count}");
            spells[s.EditorID!] = $"0x{GlobalId(s.FormKey):X8}";
        }
        md.Add("");
        md.Add("## New records");
        md.AddRange(NewRecords.Select(n => "- " + n));
        md.Add("");
        md.Add("## Notes");
        md.AddRange(Notes.Select(n => "- " + n));
        md.Add("");
        foreach (var group in Recipes.GroupBy(r => r.Kind))
        {
            md.Add($"## Recipes: {group.Key} ({group.Count()})");
            md.Add("");
            md.Add("| tier | recipe | output | origin | items | flags |");
            md.Add("|---|---|---|---|---|---|");
            foreach (var r in group.OrderBy(r => Array.IndexOf(new[] { "Anyone", "Novice", "Adept", "Expert", "Master", "disabled" }, r.Tier)).ThenBy(r => r.Output))
            {
                var flags = new List<string>();
                if (r.untouched) flags.Add("untouched");
                if (r.salted) flags.Add("salt added");
                if (r.gatesStripped) flags.Add("vanilla gates removed");
                if (r.note != null) flags.Add(r.note);
                md.Add($"| {r.Tier} | {r.Edid} | {r.Output} | {r.origin ?? key.FileName} | {string.Join(", ", r.Items)} | {string.Join("; ", flags)} |");
            }
            md.Add("");
        }
        File.WriteAllText(Path.Combine(dir, reportName), string.Join("\n", md));
        if (spells.Count == 0 && reportName != "proficiency-report.md") return;
        var json = new JsonObject
        {
            ["plugin"] = key.FileName.String,
            ["loadIndex"] = loadIndex,
            ["markerSpells"] = spells,
            ["errors"] = new JsonArray(Errors.Select(e => (JsonNode)e).ToArray()),
        };
        File.WriteAllText(Path.Combine(dir, "proficiency-ids.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}
