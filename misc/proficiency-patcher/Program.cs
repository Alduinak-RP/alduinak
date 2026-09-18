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
//   dotnet run -c Release -- --settings <server-settings.json> --plugin <precleaned AlduinakAdditions.esp> --spec <spec.json> --out <dir> [--report <dir>] [--no-creations]

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
var ctx = new PatchContext(mod, cache, additionsOrder, spec, report);
if (opts.NextFormId is uint pinned)
{
    // Pinned ids keep the marker spells stable for learnedSpells and server-settings.json; AddNew does not check for collisions
    var taken = mod.EnumerateMajorRecords().Where(r => r.FormKey.ModKey == pluginKey && r.FormKey.ID >= pinned && r.FormKey.ID < pinned + 0x100).Select(r => r.FormKey.ToString()).ToList();
    if (taken.Count > 0) throw new Exception($"--next-form-id {pinned:X}: own records already use {string.Join(", ", taken.Take(10))}");
    mod.ModHeader.Stats.NextFormID = pinned;
}

Console.WriteLine($"{pluginName}: position {position} in the load order, full slot {loadIndex:X2}, {mod.ModHeader.MasterReferences.Count} masters, next form id {mod.ModHeader.Stats.NextFormID:X}");

Steps.Keywords(ctx);
Steps.Items(ctx);
Steps.MarkerAbilities(ctx);
Steps.WoodcraftingBench(ctx);
Steps.AlchemyLabs(ctx);
Steps.AlchemyRecipes(ctx);
Steps.KilnRecipes(ctx);
Steps.Cooking(ctx);
Steps.Smithing(ctx);
Steps.Tempering(ctx);
Steps.Tailoring(ctx);
Steps.Uncraftable(ctx);
Steps.Meadery(ctx);
Steps.BenchKeywordRemovals(ctx);
Steps.BenchMoves(ctx);
Steps.EnchantmentMagnitudes(ctx);
Steps.Placements(ctx);
Steps.Writing(ctx);
Steps.Racial(ctx);
var categories = Steps.Categories(ctx);

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
if (spec["craftingCategories"] is JsonObject cat)
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

record Cli(string Settings, string Plugin, string Spec, string Out, string ReportDir, uint? NextFormId, bool NoCreations)
{
    public static Cli Parse(string[] args)
    {
        string? settings = null, plugin = null, spec = null, outDir = null, reportDir = null;
        uint? nextFormId = null;
        var noCreations = false;
        for (int i = 0; i < args.Length; i += 2)
        {
            if (args[i] == "--no-creations") { noCreations = true; i--; continue; }
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
            throw new Exception("usage: --settings <server-settings.json> --plugin <AlduinakAdditions.esp> --spec <spec.json> --out <dir> [--report <dir>] [--next-form-id <hex>] [--no-creations]");
        return new Cli(settings, plugin, spec, outDir, reportDir ?? outDir, nextFormId, noCreations);
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
        var cobj = c.OwnOrNew(c.Mod.ConstructibleObjects, edid);
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
        foreach (var edid in tierOf.Keys.Concat(needsSalt).Where(e => !seen.Contains(e)))
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
        var benches = Edids(c, r["from"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet();
        var routes = new Dictionary<string, Route>(StringComparer.OrdinalIgnoreCase);
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey) || !c.Includes(winning)) continue;
            var edid = winning.EditorID ?? "";
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
        foreach (var (edid, _) in addItems.Where(kv => !extended.Contains(kv.Key)))
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
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey) || !c.Includes(winning)) continue;
            var edid = winning.EditorID ?? "";
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
    }

    // Product -> the profession that makes it, so a temper entry asks for the rank that made the item
    static Dictionary<FormKey, string> CrafterOfProduct(PatchContext c)
    {
        var map = new Dictionary<FormKey, string>();
        foreach (var (edid, route) in c.Routes)
            if (c.TryWinning<IConstructibleObjectGetter>(edid, out var recipe)) map[recipe.CreatedObject.FormKey] = route.Profession;
        foreach (var edid in TailoringSet(c))
            if (c.TryWinning<IConstructibleObjectGetter>(edid, out var recipe)) map[recipe.CreatedObject.FormKey] = c.Spec["tailoring"]!["profession"]!.GetValue<string>();
        return map;
    }

    // ---- recipes that must never be craftable: parked on a keyword no furniture carries ---------------------------
    public static void Uncraftable(PatchContext c)
    {
        if (c.Spec["uncraftable"] is not JsonObject u) return;
        Park(c, u["recipes"]!.AsArray().Select(x => x!.GetValue<string>()), c.KeyOf<IKeywordGetter>(u["bench"]!.GetValue<string>()),
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

    // ---- bench moves: existing recipes offered at another bench only ------------------------------------------------
    public static void BenchMoves(PatchContext c)
    {
        var parked = (c.Spec["uncraftable"]?["recipes"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var m in c.Spec["benchMoves"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var bench = m["bench"]!.GetValue<string>();
            var recipes = m["recipes"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
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
            var hits = rec.Effects.Where(x => x.BaseEffect.FormKey == effect && x.Data != null).ToList();
            if (hits.Count != 1) { c.Error($"enchantment {edid}: {hits.Count} effects of {c.EdidOf(effect)}, expected 1"); continue; }
            c.Note($"Enchantment {edid} ({ench}): {c.EdidOf(effect)} magnitude {hits[0].Data!.Magnitude} -> {magnitude} on {string.Join(", ", armors.Select(a => a.EditorID))}");
            hits[0].Data!.Magnitude = magnitude;
        }
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
        c.Note($"Mead bench {edid} {placed.FormKey} in {cellEdid} at {position}, heading {rotZ}, {distance:0} units from boiler {boilerKey}");
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
        foreach (var edid in swept.Concat(listed.Keys).Distinct(StringComparer.OrdinalIgnoreCase))
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
            SetTier(c, cobj, profession, tier);
            c.Report.Recipes.Add(new RecipeLine("tailoring", edid, c.NameOf(cobj.CreatedObject.FormKey), profession, tier, Items(c, cobj), gatesStripped: stripped, origin: winning.FormKey.ModKey.FileName));
        }
        foreach (var r in t["newRecipes"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var bench = c.KeyOf<IKeywordGetter>(r["bench"]!.GetValue<string>());
            NewRecipe(c, r, bench, profession, "AldRecipeTailor_");
        }
        if (t["disableRecipes"] is JsonArray disable)
            Park(c, disable.Select(x => x!.GetValue<string>()), c.KeyOf<IKeywordGetter>(t["disabledBench"]!.GetValue<string>()), "tailoring", profession);
    }

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
                          Except: Edids(c, x["except"]).ToList())).ToList();
        var counts = rules.ToDictionary(r => r.Name, _ => 0);
        foreach (var (key, cobj) in FinalRecipes(c))
        {
            if (!benches.Contains(cobj.Bench)) continue;
            var edid = cobj.Edid;
            var made = c.Cache.TryResolve<IMajorRecordGetter>(cobj.Product, out var m) ? m : null;
            var text = $"{edid}|{made?.EditorID}|{c.NameOf(cobj.Product)}";
            var hit = rules.FirstOrDefault(r => r.Match.Any(x => text.Contains(x, StringComparison.OrdinalIgnoreCase))
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
    // It reads keywords off the created object, so a category is a keyword of the plugin's own added to every item a
    // bench's recipes make, plus a json config naming the keyword. Runs last, when every bench keyword is final.
    public static JsonObject Categories(PatchContext c)
    {
        var config = new JsonObject();
        if (c.Spec["craftingCategories"] is not JsonObject spec) return config;
        var section = spec["section"]!.GetValue<string>();
        var categories = new JsonObject();
        var final = FinalRecipes(c).Select(kv => kv.Value).ToList();
        foreach (var group in spec["groups"]!.AsArray().Select(x => x!.AsObject()))
        {
            var bench = c.KeyOf<IKeywordGetter>(group["bench"]!.GetValue<string>());
            var rules = group["categories"]!.AsArray().Select(x => x!.AsObject())
                .Select(x => (Name: x["name"]!.GetValue<string>(),
                              Key: c.OwnOrNew(c.Mod.Keywords, x["keyword"]!.GetValue<string>()).FormKey,
                              Edid: x["keyword"]!.GetValue<string>(),
                              Slots: Edids(c, x["slots"]).Select(int.Parse).ToList(),
                              Kinds: Edids(c, x["kinds"]).ToHashSet(StringComparer.OrdinalIgnoreCase),
                              Keywords: Edids(c, x["keywords"]).Select(c.KeyOf<IKeywordGetter>).ToHashSet(),
                              Items: Edids(c, x["items"]).Select(c.KeyOf<IMajorRecordGetter>).ToHashSet(),
                              Match: Edids(c, x["match"]).ToList())).ToList();
            foreach (var r in rules)
                categories[r.Name] = new JsonObject { ["section"] = section, ["keywords"] = new JsonArray(r.Edid) };
            var counts = rules.ToDictionary(r => r.Name, _ => 0);
            foreach (var product in final.Where(v => v.Bench == bench).Select(v => v.Product).Distinct())
            {
                if (!c.Cache.TryResolve<IMajorRecordGetter>(product, out var made)) continue;
                var kws = ProductKeywords(c, product, out var kind);
                var slots = made is IArmorGetter { BodyTemplate: { } body } ? (uint)body.FirstPersonFlags : 0u;
                var edid = made.EditorID ?? "";
                var hit = rules.FirstOrDefault(r =>
                    (r.Slots.Count == 0 || r.Slots.Any(sl => (slots & (1u << (sl - 30))) != 0))
                    && (r.Kinds.Count == 0 || r.Kinds.Contains(kind))
                    && (r.Keywords.Count == 0 || kws.Overlaps(r.Keywords))
                    && (r.Items.Count == 0 || r.Items.Contains(product))
                    && (r.Match.Count == 0 || r.Match.Any(m => edid.Contains(m, StringComparison.OrdinalIgnoreCase)))
                    && (r.Slots.Count + r.Kinds.Count + r.Keywords.Count + r.Items.Count + r.Match.Count > 0 || r.Name == rules[^1].Name));
                if (hit.Name == null) continue;
                Tag(c, made, hit.Key);
                counts[hit.Name] += 1;
            }
            c.Note($"Crafting categories at {group["bench"]!.GetValue<string>()}: {string.Join(", ", counts.Select(kv => $"{kv.Value} {kv.Key}"))}");
        }
        config["sections"] = new JsonObject { [section] = new JsonObject { ["priority"] = 15 } };
        config["categories"] = categories;
        return config;
    }

    // Add a keyword to an override of a created object, whatever record type it is
    static void Tag(PatchContext c, IMajorRecordGetter made, FormKey keyword)
    {
        IKeyworded<IKeywordGetter>? rec = made switch
        {
            IArmorGetter a => c.Override(c.Mod.Armors, a),
            IWeaponGetter w => c.Override(c.Mod.Weapons, w),
            IAmmunitionGetter m => c.Override(c.Mod.Ammunitions, m),
            IMiscItemGetter m => c.Override(c.Mod.MiscItems, m),
            _ => null,
        };
        if (rec == null) { c.Warn($"crafting categories: {made.EditorID} is a {made.Registration.Name}, which carries no keywords"); return; }
        rec.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
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
