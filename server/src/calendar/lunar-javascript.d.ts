declare module "lunar-javascript" {
  export interface JieQi {
    getName(): string;
    getSolar(): Solar;
  }
  export interface Lunar {
    getMonthInChinese(): string;
    getDayInChinese(): string;
    getYearInGanZhi(): string;
    getYearShengXiao(): string;
    getJieQi(): string;
    getNextJieQi(wholeDay?: boolean): JieQi;
    getFestivals(): string[];
  }
  export interface Solar {
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    toYmd(): string;
    getLunar(): Lunar;
    getFestivals(): string[];
    getWeekInChinese(): string;
  }
  export const Solar: {
    fromYmdHms(y: number, m: number, d: number, h: number, mi: number, s: number): Solar;
    fromYmd(y: number, m: number, d: number): Solar;
  };
}
