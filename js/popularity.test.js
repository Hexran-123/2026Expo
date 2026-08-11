/*
 * popularity.js の段の切り方を確かめる。
 *
 * 使い方:  node js/popularity.test.js
 *
 * 記章が出る／出ないの境目は、実際に人が読みに来ないと動かせない。
 * 数が 5 に届くまで何ヶ月かかるか分からないので、境目だけは机の上で
 * 確かめておく。ここが 1 段ずれても画面はエラーを出さず、
 * ただ「記章がなかなか出ない」ように見えるだけになる。
 *
 * fetch は試さない。宛先が生きているかどうかで結果が変わる試験は、
 * 通らなくなったときに原因が分からない。回線が要る確認は
 * supabase/local/setup_and_verify.sql と、匿名キーでの実測のほうで行う。
 */

require('./popularity.js');
const { levelFor, STEPS } = globalThis.Popularity;

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  NG   ${label}\n         期待 ${e}\n         実際 ${a}`);
  }
}

console.log('記章の段（5 / 8 / 10）');
check('0 回は出さない', levelFor(0), 0);
check('4 回はまだ出さない', levelFor(4), 0);
check('5 回でようやく 1 段目', levelFor(5), 1);
check('7 回はまだ 1 段目', levelFor(7), 1);
check('8 回で 2 段目', levelFor(8), 2);
check('9 回はまだ 2 段目', levelFor(9), 2);
check('10 回で 3 段目', levelFor(10), 3);
check('それ以上は 3 段目のまま', levelFor(9999), 3);

console.log('\n壊れた値でも段を出さない');
// 宛先が止まっている・時間切れ・作りかけの応答。どれも記章を出さない
check('null（届かなかった）', levelFor(null), 0);
check('undefined', levelFor(undefined), 0);
check('文字列', levelFor('120'), 0);
check('NaN', levelFor(NaN), 0);
check('Infinity', levelFor(Infinity), 0);

console.log('\n段の決まりそのもの');
// 上から順に見るので、並びが崩れると 10 回でも 1 段目に落ちる
check('大きいほうから並んでいる', STEPS.map((s) => s.at), [10, 8, 5]);
check('段は 3 つ', STEPS.length, 3);

console.log('');
if (failures === 0) {
  console.log('OK すべて通った');
} else {
  console.log(`NG ${failures} 件`);
  process.exitCode = 1;
}
