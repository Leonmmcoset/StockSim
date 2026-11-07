import { expect, it } from 'vitest';
import { clearingPrice, sortBook, type BookEntry } from '../src/engine/book';
const o=(id:string,side:'buy'|'sell',price:number,remaining:number,seq:number):BookEntry=>({id,side,price,remaining,seq});
it('prioritizes price and then FIFO, regardless of owner',()=>{
  const orders=[o('later','buy',1000,100,3),o('earlier','buy',1000,100,1),o('better','buy',1001,100,4)];
  expect(sortBook(orders,'buy').map(x=>x.id)).toEqual(['better','earlier','later']);
});
it('clears all auction trades at a maximum-volume price, taking midpoint of tied range',()=>{
  expect(clearingPrice([o('b','buy',1010,100,1),o('s','sell',1000,100,2)])).toBe(1005);
  expect(clearingPrice([o('b','buy',1010,200,1),o('s','sell',1000,100,2)])).toBe(1010);
  expect(clearingPrice([o('b','buy',990,100,1),o('s','sell',1000,100,2)])).toBeNull();
});
