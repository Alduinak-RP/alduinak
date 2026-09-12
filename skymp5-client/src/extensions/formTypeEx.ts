import { FormType } from "skyrimPlatform";

export class FormTypeEx {
  static readonly itemTypes: readonly FormType[] = [
    FormType.Ammo,
    FormType.Armor,
    FormType.Book,
    FormType.Ingredient,
    FormType.Light,
    FormType.Potion,
    FormType.ScrollItem,
    FormType.SoulGem,
    FormType.Weapon,
    FormType.Misc,
  ];

  static isItem(type: FormType) {
    return FormTypeEx.itemTypes.includes(type);
  }
}
