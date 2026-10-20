//! CPython `random.Random`（MT19937）的移植，抽奖要靠它复现旧批次。

const N: usize = 624;
const M: usize = 397;

pub struct PyRandom {
    mt: [u32; N],
    idx: usize,
}

impl PyRandom {
    /// 等价于 `Random(seed)`：整数种子取绝对值，按 32 位小端切成 key 数组再 `init_by_array`。
    pub fn new(seed: i64) -> Self {
        let mut a = seed.unsigned_abs();
        let mut key: Vec<u32> = Vec::new();
        while a > 0 {
            key.push((a & 0xffff_ffff) as u32);
            a >>= 32;
        }
        if key.is_empty() {
            key.push(0);
        }
        let mut r = PyRandom { mt: [0; N], idx: N + 1 };
        r.init_by_array(&key);
        r
    }

    fn init_genrand(&mut self, s: u32) {
        self.mt[0] = s;
        for i in 1..N {
            let prev = self.mt[i - 1];
            self.mt[i] = 1812433253u32.wrapping_mul(prev ^ (prev >> 30)).wrapping_add(i as u32);
        }
        self.idx = N;
    }

    fn init_by_array(&mut self, key: &[u32]) {
        self.init_genrand(19650218);
        let mut i = 1usize;
        let mut j = 0usize;
        let mut k = N.max(key.len());
        while k > 0 {
            let prev = self.mt[i - 1];
            self.mt[i] = (self.mt[i] ^ (prev ^ (prev >> 30)).wrapping_mul(1664525))
                .wrapping_add(key[j])
                .wrapping_add(j as u32);
            i += 1;
            j += 1;
            if i >= N {
                self.mt[0] = self.mt[N - 1];
                i = 1;
            }
            if j >= key.len() {
                j = 0;
            }
            k -= 1;
        }
        k = N - 1;
        while k > 0 {
            let prev = self.mt[i - 1];
            self.mt[i] = (self.mt[i] ^ (prev ^ (prev >> 30)).wrapping_mul(1566083941)).wrapping_sub(i as u32);
            i += 1;
            if i >= N {
                self.mt[0] = self.mt[N - 1];
                i = 1;
            }
            k -= 1;
        }
        self.mt[0] = 0x8000_0000;
        self.idx = N;
    }

    fn next_u32(&mut self) -> u32 {
        if self.idx >= N {
            for kk in 0..N {
                let y = (self.mt[kk] & 0x8000_0000) | (self.mt[(kk + 1) % N] & 0x7fff_ffff);
                let mut v = self.mt[(kk + M) % N] ^ (y >> 1);
                if y & 1 != 0 {
                    v ^= 0x9908_b0df;
                }
                self.mt[kk] = v;
            }
            self.idx = 0;
        }
        let mut y = self.mt[self.idx];
        self.idx += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c_5680;
        y ^= (y << 15) & 0xefc6_0000;
        y ^= y >> 18;
        y
    }

    /// `random.random()`：[0, 1) 的 53 位浮点。
    pub fn random(&mut self) -> f64 {
        let a = (self.next_u32() >> 5) as f64;
        let b = (self.next_u32() >> 6) as f64;
        (a * 67108864.0 + b) * (1.0 / 9007199254740992.0)
    }

    fn getrandbits(&mut self, k: u32) -> u32 {
        // 这里只会用到 k <= 32
        self.next_u32() >> (32 - k)
    }

    /// `random._randbelow(n)`（n >= 1）。
    pub fn randbelow(&mut self, n: u64) -> u64 {
        if n == 0 {
            return 0;
        }
        let k = 64 - n.leading_zeros();
        if k <= 32 {
            loop {
                let r = self.getrandbits(k) as u64;
                if r < n {
                    return r;
                }
            }
        }
        // 超过 32 位的上限不会出现在抽奖里，这里按 CPython 的多字拼接处理以防万一。
        loop {
            let mut r: u64 = 0;
            let mut shift = 0;
            let mut left = k;
            while left > 0 {
                let take = left.min(32);
                let w = (self.next_u32() >> (32 - take)) as u64;
                r |= w << shift;
                shift += 32;
                left -= take;
            }
            if r < n {
                return r;
            }
        }
    }

    /// `random.randrange(stop)`
    pub fn randrange(&mut self, stop: i64) -> i64 {
        self.randbelow(stop.max(0) as u64) as i64
    }

    /// `random.randint(a, b)`，闭区间。
    pub fn randint(&mut self, a: i64, b: i64) -> i64 {
        let width = b + 1 - a;
        a + self.randbelow(width.max(0) as u64) as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_42_matches_cpython() {
        let mut r = PyRandom::new(42);
        let want = [
            0.6394267984578837,
            0.025010755222666936,
            0.27502931836911926,
            0.22321073814882275,
            0.7364712141640124,
        ];
        for w in want {
            assert_eq!(r.random(), w);
        }
    }
}
