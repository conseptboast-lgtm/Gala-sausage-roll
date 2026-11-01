// ==========================================
// SUPABASE CONNECTION & HELPER FUNCTIONS
// ==========================================

const supabaseUrl = 'https://nkjborwixrcnfkvucjrl.supabase.co';
const supabaseKey = 'sb_publishable_a4Eh2DVMKolGlsmwEAWyGw_qbo45XiM';

const supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);

function getUserId() {
    return localStorage.getItem('userId');
}

// ------------------------------------------
// 1. AUTHENTICATION
// ------------------------------------------
async function requireLogin() {
    let userId = getUserId();
    if (!userId) {
        window.location.href = 'index.html';
        return null;
    }
    
    try {
        const { data, error } = await supabaseClient.from('users').select('*').eq('id', userId).single();
        if (error || !data) {
            localStorage.clear();
            window.location.href = 'index.html';
            return null;
        }
        
        // Format data for the UI
        return {
            userId: data.id,
            fullName: data.full_name,
            firstName: (data.full_name || 'User').split(' ')[0],
            phone: data.phone,
            balance: Number(data.balance) || 0,
            totalDeposit: Number(data.total_deposit) || 0,
            totalEarned: Number(data.total_earned) || 0,
            referralCode: data.referral_code,
            bankName: data.bank_name,
            bankAccount: data.bank_account,
            bankHolder: data.bank_holder,
            vipPlan: data.vip_plan,
            lastWithdrawalAt: data.last_withdrawal_at
        };
    } catch (e) {
        console.error("Auth Error:", e);
        return null;
    }
}

// ------------------------------------------
// 2. TRANSACTIONS (DEPOSITS & WITHDRAWALS)
// ------------------------------------------

async function createDeposit(amount, channel, receiptUrl) {
    const userId = getUserId();
    try {
        // 1. Insert the deposit with the receipt URL
        const { error } = await supabaseClient.from('deposits').insert([{ 
            user_id: userId, 
            amount: Number(amount), 
            channel: channel, 
            status: 'pending',
            receipt_url: receiptUrl 
        }]);
        
        if (error) throw error;
        return true;
    } catch (e) {
        console.error("Deposit Error:", e);
        return false;
    }
}

function canWithdrawToday(lastWithdrawalAt) {
    if (!lastWithdrawalAt) return true;
    const lastDate = new Date(lastWithdrawalAt).toDateString();
    const todayDate = new Date().toDateString();
    return lastDate !== todayDate;
}

async function processWithdrawal(amount) {
    const userId = getUserId();
    
    try {
        // 1. Get user details
        const { data: user, error } = await supabaseClient.from('users').select('balance, last_withdrawal_at').eq('id', userId).single();
        if (error) throw new Error("Could not fetch user data");

        // 2. Check daily limit
        if (!canWithdrawToday(user.last_withdrawal_at)) {
            throw new Error("You can only withdraw once a day. Please try again tomorrow.");
        }

        // 3. Check balance
        if (Number(amount) > Number(user.balance)) {
            throw new Error("Insufficient balance.");
        }

        // 4. Create Withdrawal Record
        const { error: withError } = await supabaseClient.from('withdrawals').insert([{ 
            user_id: userId, 
            amount: Number(amount), 
            status: 'pending' 
        }]);
        if (withError) throw new Error("Error creating withdrawal request");

        // 5. Deduct balance and set last_withdrawal_at
        const newBalance = Number(user.balance) - Number(amount);
        const { error: updateError } = await supabaseClient.from('users').update({ 
            balance: newBalance,
            last_withdrawal_at: new Date().toISOString()
        }).eq('id', userId);
        
        if (updateError) throw new Error("Error updating balance");

        return true;
    } catch (e) {
        throw e;
    }
}

async function getTransactions() {
    const userId = getUserId();
    try {
        const { data: deps } = await supabaseClient.from('deposits').select('*').eq('user_id', userId);
        const { data: withs } = await supabaseClient.from('withdrawals').select('*').eq('user_id', userId);
        let all = [];
        if(deps) deps.forEach(d => all.push({...d, type: 'in'}));
        if(withs) withs.forEach(w => all.push({...w, type: 'out'}));
        return all.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    } catch (e) { return []; }
}

// ------------------------------------------
// 3. REFERRAL BONUS SYSTEM
// ------------------------------------------
async function processReferralBonus(currentUserId, depositAmount) {
    // Exact requested bonuses
    const bonuses = {
        4500: 1500,   // VIP 1 -> Referrer gets 1,500
        11000: 3600,  // VIP 2 -> Referrer gets 3,600
        25000: 7500,
        55000: 16500,
        100000: 30000
    };

    const bonus = bonuses[depositAmount] || 0;
    if (bonus === 0) return; 

    try {
        // 1. Find who referred this user
        const { data: currentUser } = await supabaseClient.from('users').select('referred_by').eq('id', currentUserId).single();
        
        if (currentUser && currentUser.referred_by) {
            // 2. Find the referrer's account
            const { data: referrer } = await supabaseClient.from('users').select('id, balance, total_earned').eq('referral_code', currentUser.referred_by).single();
            
            if (referrer) {
                // 3. Add the bonus to the referrer's balance
                const newBalance = Number(referrer.balance || 0) + bonus;
                const newEarned = Number(referrer.total_earned || 0) + bonus;
                
                await supabaseClient.from('users').update({ 
                    balance: newBalance, 
                    total_earned: newEarned 
                }).eq('id', referrer.id);
                
                console.log(`Paid ₦${bonus} bonus to referrer ${currentUser.referred_by}`);
            }
        }
    } catch (e) {
        console.error("Error processing referral bonus:", e);
    }
}

// ------------------------------------------
// 4. DAILY TASKS (SELLING)
// ------------------------------------------
async function getUserProducts() {
    const userId = getUserId();
    try {
        const { data, error } = await supabaseClient.from('user_products').select('*').eq('user_id', userId).order('created_at', { ascending: false });
        if (error) throw error;
        return data || [];
    } catch (e) { return []; }
}

async function getDailyTaskCount() {
    const userId = getUserId();
    const today = new Date();
    today.setHours(0,0,0,0); // Start of today
    
    try {
        const { count, error } = await supabaseClient
            .from('user_products')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .gte('created_at', today.toISOString());
        return count || 0;
    } catch (e) { return 0; }
}

async function createUserProduct(vipLevel, earning) {
    const userId = getUserId();
    try {
        const { error } = await supabaseClient.from('user_products').insert([{ 
            user_id: userId, vip_level: vipLevel, earning: Number(earning), status: 'pending'
        }]);
        if (error) throw error;
        return true;
    } catch (e) { return false; }
}

async function completeProductTask(taskId, earning) {
    const userId = getUserId();
    try {
        // 1. Mark task as completed
        await supabaseClient.from('user_products').update({ status: 'completed' }).eq('id', taskId);
        
        // 2. Add earnings to user's balance
        const { data: user } = await supabaseClient.from('users').select('balance, total_earned').eq('id', userId).single();
        const newBalance = Number(user.balance || 0) + Number(earning);
        const newTotalEarned = Number(user.total_earned || 0) + Number(earning);
        
        await supabaseClient.from('users').update({ 
            balance: newBalance, 
            total_earned: newTotalEarned 
        }).eq('id', userId);
        
        return true;
    } catch (e) { return false; }
}

// ------------------------------------------
// 5. PROFILE & BANK DETAILS
// ------------------------------------------
async function updateBankDetails(bankName, accountNumber, accountName, pin) {
    const userId = getUserId();
    try {
        const { error } = await supabaseClient.from('users').update({ 
            bank_name: bankName, 
            bank_account: accountNumber, 
            bank_holder: accountName, 
            pin: pin 
        }).eq('id', userId);
        
        if (error) throw error;
        return true;
    } catch (e) { return false; }
}

// ------------------------------------------
// 6. LOGOUT
// ------------------------------------------
function logout() {
    if (confirm("Are you sure you want to log out?")) {
        localStorage.removeItem('userId');
        window.location.href = 'index.html';
    }
}
// Add to the bottom of supabase.js

async function buyVIPWithBalance(vipPlan, amount) {
    const userId = getUserId();
    try {
        // 1. Get current user balance
        const { data: user, error } = await supabaseClient.from('users').select('balance').eq('id', userId).single();
        if (error) throw error;

        // 2. Check if balance is sufficient
        if (Number(user.balance) < Number(amount)) {
            return { success: false, message: "Insufficient funds. Please deposit to upgrade." };
        }

        // 3. Deduct balance and assign VIP plan
        const newBalance = Number(user.balance) - Number(amount);
        
        const { error: updateError } = await supabaseClient.from('users').update({
            balance: newBalance,
            vip_plan: vipPlan
        }).eq('id', userId);
        
        if (updateError) throw updateError;

        // 4. Record this purchase in their transaction history (Money Out)
        await supabaseClient.from('withdrawals').insert([{
            user_id: userId,
            amount: Number(amount),
            status: 'approved' 
        }]);

        return { success: true, message: `${vipPlan} activated successfully!` };
    } catch (e) {
        console.error(e);
        return { success: false, message: "An error occurred. Please try again." };
    }
}